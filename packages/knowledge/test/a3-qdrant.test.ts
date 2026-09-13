/**
 * A3 — Qdrant upsert and filter.
 *
 * "1,000 synthetic points; filters by competitor, layer, vantage, run correct;
 *  duplicate id adds no point."
 *
 * Runs against a real Qdrant. Never fakes a pass.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Layer, Observation } from "@periscope/contracts";

import { Corpus, observationIdToPointId } from "../src/corpus.js";
import type { Storage } from "../src/storage.js";
import { DeterministicEmbedder } from "./fake-embedder.js";
import {
  makeObservation,
  observationEvent,
  seedRunAndJob,
  tempStorage,
} from "./helpers.js";
import {
  makeStore,
  QDRANT_HELP,
  qdrantReachable,
  qdrantUrl,
  skipQdrant,
  testCollectionName,
} from "./qdrant-env.js";

const COMPETITORS = ["ornn", "linear", "acme", "globex", "initech"] as const;
const LAYERS: readonly Layer[] = ["surface", "hidden", "borders", "interior"];
const COUNTRIES = ["CA", "US", "DE"] as const;
const TOTAL = 1_000;

describe.skipIf(skipQdrant)("A3 — Qdrant upsert and filter", () => {
  const collection = testCollectionName("a3");
  let storage: Storage;
  let cleanup: () => void;
  let corpus: Corpus;
  let observations: Observation[] = [];

  beforeAll(async () => {
    if (!(await qdrantReachable(qdrantUrl()))) throw new Error(QDRANT_HELP);

    const t = tempStorage();
    storage = t.storage;
    cleanup = t.cleanup;

    const { runId, jobId } = seedRunAndJob(storage, "run-a3", "job-a3");
    storage.createRun({ id: "run-a3-other", goal: "second run" });
    storage.createJob({ id: "job-a3-other", runId: "run-a3-other", purpose: "walker", competitor: "ornn" });

    // 1,000 deterministic synthetic observations, spread across every filter axis.
    for (let i = 0; i < TOTAL; i += 1) {
      const competitor = COMPETITORS[i % COMPETITORS.length] as string;
      const layer = LAYERS[i % LAYERS.length] as Layer;
      const country = COUNTRIES[i % COUNTRIES.length] as string;
      const device = i % 2 === 0 ? "desktop" : "mobile";
      const authenticated = layer === "interior";
      const useOtherRun = i % 10 === 0;

      const observation = makeObservation(
        useOtherRun ? "run-a3-other" : runId,
        useOtherRun ? "job-a3-other" : jobId,
        {
          competitor,
          layer,
          source: layer === "surface" ? "steel_scrape" : "browser",
          url: `https://${competitor}.com/page-${i % 20}`,
          text: `synthetic observation ${i} for ${competitor} on ${layer}`,
          vantage: { country, device, authenticated },
          ...(layer === "surface" ? { revealedBy: { action: "none" as const } } : {}),
          capturedAt: new Date(Date.UTC(2026, 8, 13, 0, 0, i)).toISOString(),
        },
      );
      const outcome = storage.write(observationEvent(observation));
      expect(outcome.status).toBe("written");
      observations.push(observation);
    }

    expect(observations).toHaveLength(TOTAL);

    const vectors = makeStore(collection);
    await vectors.dropCollection();
    corpus = new Corpus({
      storage,
      embedder: new DeterministicEmbedder(384),
      vectors,
      config: { collection, batchSize: 128 },
    });
    await corpus.ensureCollection();
  }, 600_000);

  afterAll(async () => {
    if (skipQdrant) return;
    try {
      await makeStore(collection).dropCollection();
    } finally {
      cleanup?.();
    }
  });

  it("indexes 1,000 observations, one point each", async () => {
    const outcome = await corpus.indexPending(TOTAL);
    expect(outcome.failed).toBe(0);
    expect(outcome.indexed).toBe(TOTAL);
    expect(await corpus.count()).toBe(TOTAL);
    expect(storage.countPendingEmbeddings()).toBe(0);
  });

  it("does not grow the collection when the same ids are indexed again", async () => {
    const before = await corpus.count();
    expect(before).toBe(TOTAL);

    await corpus.indexObservations(observations);
    expect(await corpus.count()).toBe(TOTAL);

    // And a single duplicate id upserts in place.
    const one = observations[0] as Observation;
    await corpus.indexObservations([one, one, one]);
    expect(await corpus.count()).toBe(TOTAL);
  });

  it("derives point ids deterministically from observation ids", () => {
    const one = observations[0] as Observation;
    const a = observationIdToPointId(one.id);
    const b = observationIdToPointId(one.id);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(observationIdToPointId(observations[1]?.id ?? "")).not.toBe(a);
  });

  it("filters by competitor", async () => {
    const hits = await corpus.search("synthetic observation", {
      limit: 200,
      filter: { competitor: "ornn" },
    });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.payload.competitor === "ornn")).toBe(true);
  });

  it("filters by layer", async () => {
    const hits = await corpus.search("synthetic observation", {
      limit: 200,
      filter: { layer: "hidden" },
    });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.payload.layer === "hidden")).toBe(true);

    const multi = await corpus.search("synthetic observation", {
      limit: 300,
      filter: { layer: ["hidden", "borders"] },
    });
    expect(multi.every((h) => h.payload.layer === "hidden" || h.payload.layer === "borders")).toBe(true);
  });

  it("filters by run", async () => {
    const hits = await corpus.search("synthetic observation", {
      limit: 300,
      filter: { runId: "run-a3-other" },
    });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.payload.runId === "run-a3-other")).toBe(true);
    expect(hits.length).toBeLessThanOrEqual(TOTAL / 10);
  });

  it("filters by country, device and authentication state", async () => {
    const byCountry = await corpus.search("synthetic observation", {
      limit: 200,
      filter: { country: "DE" },
    });
    expect(byCountry.length).toBeGreaterThan(0);
    expect(byCountry.every((h) => h.payload.country === "DE")).toBe(true);

    const byDevice = await corpus.search("synthetic observation", {
      limit: 200,
      filter: { device: "mobile" },
    });
    expect(byDevice.length).toBeGreaterThan(0);
    expect(byDevice.every((h) => h.payload.device === "mobile")).toBe(true);

    const authed = await corpus.search("synthetic observation", {
      limit: 200,
      filter: { authenticated: true },
    });
    expect(authed.length).toBeGreaterThan(0);
    expect(authed.every((h) => h.payload.authenticated === true)).toBe(true);
    expect(authed.every((h) => h.payload.layer === "interior")).toBe(true);
  });

  it("combines filters", async () => {
    const hits = await corpus.search("synthetic observation", {
      limit: 200,
      filter: { competitor: "ornn", layer: "interior", device: "desktop" },
    });
    for (const hit of hits) {
      expect(hit.payload.competitor).toBe("ornn");
      expect(hit.payload.layer).toBe("interior");
      expect(hit.payload.device).toBe("desktop");
    }
  });

  it("returns observation ids and scores, and hydrates evidence from SQLite", async () => {
    const hits = await corpus.search("synthetic observation 42 for", { limit: 5 });
    expect(hits.length).toBe(5);
    for (const hit of hits) {
      expect(typeof hit.observationId).toBe("string");
      expect(typeof hit.score).toBe("number");
    }

    const hydrated = await corpus.searchHydrated("synthetic observation 42 for", { limit: 5 });
    expect(hydrated.length).toBe(5);
    for (const hit of hydrated) {
      // The authoritative record comes from SQLite, not from the Qdrant payload.
      expect(hit.observation.id).toBe(hit.observationId);
      expect(storage.getObservation(hit.observationId)?.text).toBe(hit.observation.text);
    }
  });
});

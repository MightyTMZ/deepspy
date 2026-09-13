/**
 * A4 — Rebuild.
 *
 * "Drop Qdrant, rebuild from SQLite: identical point count and ids."
 *
 * This is the guarantee that Qdrant holds nothing authoritative.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Layer } from "@periscope/contracts";

import { Corpus, observationIdToPointId } from "../src/corpus.js";
import type { Storage } from "../src/storage.js";
import { DeterministicEmbedder } from "./fake-embedder.js";
import { makeObservation, observationEvent, seedRunAndJob, tempStorage } from "./helpers.js";
import {
  makeStore,
  QDRANT_HELP,
  qdrantReachable,
  qdrantUrl,
  skipQdrant,
  testCollectionName,
} from "./qdrant-env.js";

const LAYERS: readonly Layer[] = ["surface", "hidden", "borders", "interior"];
const TOTAL = 250;

describe.skipIf(skipQdrant)("A4 — rebuild from SQLite", () => {
  const collection = testCollectionName("a4");
  let storage: Storage;
  let cleanup: () => void;
  let corpus: Corpus;
  const expectedIds: string[] = [];

  beforeAll(async () => {
    if (!(await qdrantReachable(qdrantUrl()))) throw new Error(QDRANT_HELP);

    const t = tempStorage();
    storage = t.storage;
    cleanup = t.cleanup;

    const { runId, jobId } = seedRunAndJob(storage, "run-a4", "job-a4");
    for (let i = 0; i < TOTAL; i += 1) {
      const layer = LAYERS[i % LAYERS.length] as Layer;
      const observation = makeObservation(runId, jobId, {
        layer,
        source: layer === "surface" ? "steel_scrape" : "browser",
        url: `https://ornn.com/page-${i % 7}`,
        text: `rebuild fixture ${i}`,
        ...(layer === "surface" ? { revealedBy: { action: "none" as const } } : {}),
      });
      expect(storage.write(observationEvent(observation)).status).toBe("written");
      expectedIds.push(observation.id);
    }

    const vectors = makeStore(collection);
    await vectors.dropCollection();
    corpus = new Corpus({
      storage,
      embedder: new DeterministicEmbedder(384),
      vectors,
      config: { collection, batchSize: 64 },
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

  it("builds the index from SQLite, then rebuilds it identically after a drop", async () => {
    // 1. Build.
    const first = await corpus.indexPending(TOTAL);
    expect(first.failed).toBe(0);
    expect(first.indexed).toBe(TOTAL);

    const countBefore = await corpus.count();
    expect(countBefore).toBe(TOTAL);
    expect(storage.countPendingEmbeddings()).toBe(0);

    const idsBefore = await collectObservationIds(corpus, TOTAL);
    expect(idsBefore.size).toBe(TOTAL);
    expect([...idsBefore].sort()).toEqual([...expectedIds].sort());

    // 2. Drop. Qdrant now holds nothing.
    await corpus.dropCollection();
    expect(await corpus.count()).toBe(0);

    // 3. Rebuild purely from SQLite.
    const rebuilt = await corpus.rebuild();
    expect(rebuilt.points).toBe(TOTAL);
    expect(rebuilt.observationIds).toHaveLength(TOTAL);

    // 4. Identical point count and ids.
    const countAfter = await corpus.count();
    expect(countAfter).toBe(countBefore);

    const idsAfter = await collectObservationIds(corpus, TOTAL);
    expect(idsAfter.size).toBe(idsBefore.size);
    expect([...idsAfter].sort()).toEqual([...idsBefore].sort());

    // Point ids are derived, so they are identical too.
    const pointIdsBefore = [...idsBefore].map(observationIdToPointId).sort();
    const pointIdsAfter = [...idsAfter].map(observationIdToPointId).sort();
    expect(pointIdsAfter).toEqual(pointIdsBefore);

    // SQLite never lost anything and the outbox is drained again.
    expect(storage.countObservations()).toBe(TOTAL);
    expect(storage.countPendingEmbeddings()).toBe(0);
  });
});

/** Sweep the collection through search to recover every indexed observation id. */
async function collectObservationIds(corpus: Corpus, expected: number): Promise<Set<string>> {
  const found = new Set<string>();
  for (const layer of ["surface", "hidden", "borders", "interior"] as const) {
    const hits = await corpus.search("rebuild fixture", { limit: expected, filter: { layer } });
    for (const hit of hits) found.add(hit.observationId);
  }
  return found;
}

/**
 * A1 — SQLite schema.
 *
 * "Insert run, job, observation, finding; query by run; duplicate observation
 *  id rejected."
 *
 * Plus the milestone requirement: the rejected duplicate must produce no extra
 * event and no extra embedding-outbox entry.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LATEST_VERSION } from "../src/migrations.js";
import type { Storage } from "../src/storage.js";
import {
  makeObservation,
  observationEvent,
  ORNN_DOCUMENTS,
  seedRunAndJob,
  tempStorage,
} from "./helpers.js";

describe("A1 — SQLite schema", () => {
  let storage: Storage;
  let cleanup: () => void;

  beforeEach(() => {
    const t = tempStorage();
    storage = t.storage;
    cleanup = t.cleanup;
  });

  afterEach(() => cleanup());

  it("applies migrations and reports the schema version", () => {
    expect(storage.schemaVersion()).toBe(LATEST_VERSION);
  });

  it("inserts a run, job, observation and finding, then queries them by run", () => {
    const { runId, jobId } = seedRunAndJob(storage);

    const run = storage.getRun(runId);
    expect(run).not.toBeNull();
    expect(run?.goal).toBe("coverage gap");
    expect(run?.capMicroUsd).toBe(75_000_000); // exact micro-dollars

    const job = storage.getJob(jobId);
    expect(job?.runId).toBe(runId);
    expect(job?.purpose).toBe("reveal");
    expect(job?.state).toBe("queued");
    expect(storage.getJobsByRun(runId)).toHaveLength(1);

    const observation = makeObservation(runId, jobId, { missedByFetch: true });
    const outcome = storage.write(observationEvent(observation));
    expect(outcome.status).toBe("written");

    const byRun = storage.getObservationsByRun(runId);
    expect(byRun).toHaveLength(1);
    expect(byRun[0]?.id).toBe(observation.id);
    expect(byRun[0]?.text).toBe("Service Level Agreement");
    expect(byRun[0]?.missedByFetch).toBe(true);
    expect(byRun[0]?.revealedBy?.action).toBe("click");
    expect(byRun[0]?.vantage).toEqual(observation.vantage);

    const finding = storage.createFinding({
      id: "finding-1",
      runId,
      competitor: "ornn",
      kind: "coverage",
      title: "Four documents fetch never saw",
      observationIds: [observation.id],
    });
    expect(finding.observationIds).toEqual([observation.id]);
    expect(finding.status).toBe("observed"); // never verified_working by default

    const findings = storage.getFindingsByRun(runId);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.id).toBe("finding-1");
    expect(storage.getFindingsByRun(runId, "coverage")).toHaveLength(1);
    expect(storage.getFindingsByRun(runId, "pricing")).toHaveLength(0);
  });

  it("filters observations by competitor, layer, source, vantage and missedByFetch", () => {
    const { runId, jobId } = seedRunAndJob(storage);

    for (const text of ORNN_DOCUMENTS) {
      storage.write(observationEvent(makeObservation(runId, jobId, { text, missedByFetch: true })));
    }
    storage.write(
      observationEvent(
        makeObservation(runId, jobId, {
          text: "IOSCO",
          layer: "surface",
          source: "steel_scrape",
          missedByFetch: false,
          revealedBy: { action: "none" },
        }),
      ),
    );

    expect(storage.getObservationsByRun(runId)).toHaveLength(5);
    expect(storage.getObservationsByRun(runId, { layer: "hidden" })).toHaveLength(4);
    expect(storage.getObservationsByRun(runId, { layer: "surface" })).toHaveLength(1);
    expect(storage.getObservationsByRun(runId, { source: "browser" })).toHaveLength(4);
    expect(storage.getObservationsByRun(runId, { missedByFetch: true })).toHaveLength(4);
    expect(storage.getObservationsByRun(runId, { competitor: "ornn" })).toHaveLength(5);
    expect(storage.getObservationsByRun(runId, { competitor: "linear" })).toHaveLength(0);
    expect(storage.getObservationsByRun(runId, { device: "desktop" })).toHaveLength(5);
    expect(storage.getObservationsByRun(runId, { device: "mobile" })).toHaveLength(0);
    expect(storage.getObservationsByRun(runId, { country: "CA" })).toHaveLength(5);
    expect(storage.getObservationsByRun(runId, { authenticated: false })).toHaveLength(5);
    expect(storage.getObservationsByRun(runId, { authenticated: true })).toHaveLength(0);
  });

  it("rejects a duplicate observation id without adding an event or outbox entry", () => {
    const { runId, jobId } = seedRunAndJob(storage);
    const observation = makeObservation(runId, jobId);

    const first = storage.write(observationEvent(observation));
    expect(first.status).toBe("written");

    const eventsAfterFirst = storage.countEvents(runId);
    const outboxAfterFirst = storage.countPendingEmbeddings();
    expect(eventsAfterFirst).toBe(1);
    expect(outboxAfterFirst).toBe(1);

    // Same deterministic id, arriving a second time.
    const second = storage.write(observationEvent(observation));
    expect(second.status).toBe("duplicate");
    if (second.status === "duplicate") {
      expect(second.observationId).toBe(observation.id);
    }

    expect(storage.countObservations(runId)).toBe(1);
    expect(storage.countEvents(runId)).toBe(eventsAfterFirst); // no extra event
    expect(storage.countPendingEmbeddings()).toBe(outboxAfterFirst); // no extra outbox row

    // And a re-run of the whole reveal pass does not grow the counter.
    for (const text of ORNN_DOCUMENTS) {
      storage.write(observationEvent(makeObservation(runId, jobId, { text })));
    }
    const afterFirstPass = storage.countObservations(runId);
    for (const text of ORNN_DOCUMENTS) {
      storage.write(observationEvent(makeObservation(runId, jobId, { text })));
    }
    expect(storage.countObservations(runId)).toBe(afterFirstPass);
  });

  it("rejects a finding with no evidence", () => {
    const { runId } = seedRunAndJob(storage);
    expect(() =>
      storage.createFinding({
        id: "finding-empty",
        runId,
        competitor: "ornn",
        kind: "coverage",
        observationIds: [],
      }),
    ).toThrow(/no evidence/i);
  });

  it("rejects a finding whose evidence does not exist", () => {
    const { runId } = seedRunAndJob(storage);
    expect(() =>
      storage.createFinding({
        id: "finding-ghost",
        runId,
        competitor: "ornn",
        kind: "coverage",
        observationIds: ["0".repeat(64)],
      }),
    ).toThrow();
    expect(storage.getFinding("finding-ghost")).toBeNull();
  });
});

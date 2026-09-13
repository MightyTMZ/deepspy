/**
 * A2 — Transactional writes.
 *
 * "Kill mid-write: no job without its event, no event without its job."
 *
 * Plus: event ordering and readEventsAfter with no duplicates, missing
 * association context, foreign-key enforcement, and migration idempotency.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import Database from "better-sqlite3";

import { AssociationError, MigrationError, Storage, StorageError } from "../src/storage.js";
import { LATEST_VERSION, MIGRATIONS } from "../src/migrations.js";
import {
  makeObservation,
  observationEvent,
  seedRunAndJob,
  tempDir,
  tempStorage,
} from "./helpers.js";

describe("A2 — transactional writes", () => {
  let storage: Storage;
  let cleanup: () => void;

  beforeEach(() => {
    const t = tempStorage();
    storage = t.storage;
    cleanup = t.cleanup;
  });

  afterEach(() => cleanup());

  it("commits a job transition and its event together", () => {
    const { runId, jobId } = seedRunAndJob(storage);

    const outcome = storage.write({
      type: "job_state",
      data: { jobId, state: "running" },
    });
    expect(outcome.status).toBe("written");

    expect(storage.getJob(jobId)?.state).toBe("running");
    const events = storage.readEventsAfter(runId, 0);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("job_state");
    expect(events[0]?.jobId).toBe(jobId);
  });

  it("rolls back the whole operation when the transition fails", () => {
    const { runId, jobId } = seedRunAndJob(storage);
    storage.write({ type: "job_state", data: { jobId, state: "running" } });

    const eventsBefore = storage.countEvents(runId);
    const stateBefore = storage.getJob(jobId)?.state;

    // 'exploded' is not a member of the JobState CHECK constraint, so the
    // UPDATE fails and must take the event insert down with it.
    expect(() =>
      storage.write({
        type: "job_state",
        // deliberately invalid at runtime; the contract type is bypassed on purpose
        data: { jobId, state: "exploded" as never },
      }),
    ).toThrow();

    expect(storage.getJob(jobId)?.state).toBe(stateBefore); // no transition
    expect(storage.countEvents(runId)).toBe(eventsBefore); // no orphan event
  });

  it("rolls back the event and the spend when a receipt violates a constraint", () => {
    const { runId, jobId } = seedRunAndJob(storage);

    // A receipt reusing (job_id, step) violates UNIQUE, after its event row was
    // already inserted in the same transaction. Everything must roll back.
    const receipt = {
      jobId, step: 1, action: "click", before: "a", after: "b",
      ok: true, tokensIn: 10, tokensOut: 5, usd: 0.01,
    } as const;

    storage.write({ type: "receipt", data: { ...receipt } });
    const eventsBefore = storage.countEvents(runId);
    const spendBefore = storage.runSpendMicroUsd(runId);

    expect(() => storage.write({ type: "receipt", data: { ...receipt } })).toThrow();

    expect(storage.countEvents(runId)).toBe(eventsBefore);
    expect(storage.runSpendMicroUsd(runId)).toBe(spendBefore);
    expect(storage.countEvents(runId, "receipt")).toBe(1);
  });

  it("never leaves an observation without its event and outbox row", () => {
    const { runId, jobId } = seedRunAndJob(storage);
    for (let i = 0; i < 5; i += 1) {
      storage.write(observationEvent(makeObservation(runId, jobId, { text: `block ${i}` })));
    }
    expect(storage.countObservations(runId)).toBe(5);
    expect(storage.countEvents(runId, "observation")).toBe(5);
    expect(storage.countPendingEmbeddings()).toBe(5);
  });

  it("orders events monotonically and replays with no gaps or duplicates", () => {
    const { runId, jobId } = seedRunAndJob(storage);

    storage.write({ type: "job_state", data: { jobId, state: "starting" } });
    storage.write({ type: "job_state", data: { jobId, state: "running" } });
    for (let i = 0; i < 8; i += 1) {
      storage.write(observationEvent(makeObservation(runId, jobId, { text: `item ${i}` })));
    }
    storage.write({ type: "counter", data: { competitor: "ornn", url: "https://ornn.com/regulatory", missed: 4 } }, { runId });
    storage.write({ type: "job_state", data: { jobId, state: "completed" } });
    storage.write({ type: "run_done", data: { runId } });

    const all = storage.readEventsAfter(runId, 0);
    expect(all).toHaveLength(13);

    const ids = all.map((e) => e.eventId);
    expect(ids).toEqual([...ids].sort((a, b) => a - b)); // monotonic
    expect(new Set(ids).size).toBe(ids.length); // unique

    // Page through the way SSE reconnect does: nothing missed, nothing repeated.
    const seen: number[] = [];
    let cursor = 0;
    for (;;) {
      const page = storage.readEventsAfter(runId, cursor, 3);
      if (page.length === 0) break;
      for (const event of page) seen.push(event.eventId);
      cursor = page[page.length - 1]?.eventId ?? cursor;
    }
    expect(seen).toEqual(ids);

    // Reconnect from the middle.
    const mid = ids[5] as number;
    const tail = storage.readEventsAfter(runId, mid);
    expect(tail.map((e) => e.eventId)).toEqual(ids.filter((id) => id > mid));

    // Payloads survive the round trip as validated contract events.
    const runDone = all[all.length - 1];
    expect(runDone?.event.type).toBe("run_done");
    if (runDone?.event.type === "run_done") {
      expect(runDone.event.data.runId).toBe(runId);
    }
  });

  it("requires explicit context for a counter event", () => {
    const { runId } = seedRunAndJob(storage);
    const counter = {
      type: "counter",
      data: { competitor: "ornn", url: "https://ornn.com/regulatory", missed: 4 },
    } as const;

    // No context: competitor and url are never used to guess association.
    expect(() => storage.write(counter)).toThrow(AssociationError);
    expect(() => storage.write(counter)).toThrow(/never used to guess/i);

    expect(storage.write(counter, { runId }).status).toBe("written");
    expect(storage.countEvents(runId, "counter")).toBe(1);
  });

  it("resolves a run through jobId when the payload has no runId", () => {
    const { runId, jobId } = seedRunAndJob(storage);
    const outcome = storage.write(
      { type: "counter", data: { competitor: "ornn", url: "https://ornn.com/x", missed: "uncertain" } },
      { jobId },
    );
    expect(outcome.status).toBe("written");
    const events = storage.readEventsAfter(runId, 0);
    expect(events[0]?.runId).toBe(runId);
    expect(events[0]?.jobId).toBe(jobId);
  });

  it("rejects events that reference unknown runs or jobs", () => {
    const { runId, jobId } = seedRunAndJob(storage);

    expect(() =>
      storage.write({ type: "job_state", data: { jobId: "job-missing", state: "running" } }),
    ).toThrow(AssociationError);

    expect(() => storage.write({ type: "spend", data: { runId: "run-missing", usd: 1, cap: 75 } })).toThrow(
      AssociationError,
    );

    expect(() => storage.write({ type: "run_done", data: { runId: "run-missing" } })).toThrow(
      AssociationError,
    );

    // An observation claiming a run that does not own its job is refused.
    const mismatched = makeObservation("run-other", jobId);
    expect(() => storage.write(observationEvent(mismatched))).toThrow(AssociationError);
    expect(storage.countObservations(runId)).toBe(0);
  });

  it("enforces foreign keys", () => {
    expect(() =>
      storage.createJob({ id: "job-orphan", runId: "run-missing", purpose: "reveal" }),
    ).toThrow(StorageError);
    expect(storage.getJob("job-orphan")).toBeNull();
  });

  it("stores money as exact integer micro-dollars", () => {
    const { runId, jobId } = seedRunAndJob(storage);

    // 0.1 + 0.2 famously misbehaves as floats; integers must not.
    storage.write({
      type: "receipt",
      data: { jobId, step: 1, action: "vision", before: "a", after: "b", ok: true, tokensIn: 1, tokensOut: 1, usd: 0.1 },
    });
    storage.write({
      type: "receipt",
      data: { jobId, step: 2, action: "vision", before: "b", after: "c", ok: true, tokensIn: 1, tokensOut: 1, usd: 0.2 },
    });

    expect(storage.runSpendMicroUsd(runId)).toBe(300_000);
    expect(storage.getRun(runId)?.spentMicroUsd).toBe(300_000);
    // A16: the run's reported spend equals the sum of its receipts.
    expect(storage.getRun(runId)?.spentMicroUsd).toBe(storage.runSpendMicroUsd(runId));
  });

  it("is idempotent across repeated migrations and reopens", () => {
    const dir = tempDir();
    const path = join(dir.path, "idempotent.db");
    try {
      const first = Storage.open({ path });
      const r1 = first.migrate();
      // A fresh database applies every known migration, whatever the count.
      expect(r1.applied).toEqual(MIGRATIONS.map((m) => m.version));
      expect(first.schemaVersion()).toBe(LATEST_VERSION);
      seedRunAndJob(first, "run-x", "job-x");

      const r2 = first.migrate(); // second call on the same handle
      expect(r2.applied).toEqual([]);
      expect(first.schemaVersion()).toBe(LATEST_VERSION);
      first.close();

      // Reopening an existing database must not delete or recreate anything.
      const second = Storage.open({ path });
      const r3 = second.migrate();
      expect(r3.applied).toEqual([]);
      expect(second.getRun("run-x")).not.toBeNull();
      expect(second.getJob("job-x")).not.toBeNull();
      second.close();
    } finally {
      dir.cleanup();
    }
  });

  it("refuses to touch a database written by a newer build", () => {
    const dir = tempDir();
    const path = join(dir.path, "future.db");
    try {
      const s = Storage.open({ path });
      s.migrate();
      s.close();

      // Simulate a teammate's newer schema. Tests may open SQLite directly to
      // verify; production code goes through Storage only.
      const raw = new Database(path);
      raw
        .prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)")
        .run(LATEST_VERSION + 1, "from_the_future", new Date().toISOString());
      raw.close();

      const reopened = Storage.open({ path });
      try {
        expect(() => reopened.migrate()).toThrow(MigrationError);
        expect(() => reopened.migrate()).toThrow(/newer than this build/i);
      } finally {
        reopened.close();
      }
    } finally {
      dir.cleanup();
    }
  });

  it("rejects writes after close", () => {
    const { runId, jobId } = seedRunAndJob(storage);
    const observation = makeObservation(runId, jobId);
    storage.close();
    expect(() => storage.write(observationEvent(observation))).toThrow(StorageError);
  });
});

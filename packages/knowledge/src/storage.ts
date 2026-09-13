/**
 * storage.ts — the Periscope system of record.
 *
 * Architecture 5 / 8.1:
 *   "Ayan's storage.ts is the only writer to SQLite. B and C call
 *    storage.write(event) and never open the database themselves."
 *
 * Accordingly the `Database` handle is a private field. There is no getter,
 * no `exec`, no escape hatch. Everything goes through the typed API below.
 *
 * Guarantees:
 *   - WAL journal, foreign keys ON, busy timeout set.
 *   - Prepared statements, explicit transactions.
 *   - Each job transition and its event land in ONE transaction.
 *   - An observation, its ordered event and its embedding-outbox row land in
 *     ONE transaction.
 *   - A duplicate observation id is rejected and adds NO event and NO outbox row.
 *   - Money is stored as integer micro-dollars.
 *   - Never call MiniLM or Qdrant inside these transactions. Outbox rows are
 *     read in one short transaction, embedded outside, marked in another.
 */

import Database from "better-sqlite3";
import type { Database as Db, Statement } from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import type {
  ActionReceipt,
  Event,
  JobState,
  Layer,
  Observation,
  Source,
  Vantage,
} from "@periscope/contracts";

import { LATEST_VERSION, MIGRATIONS } from "./migrations.js";
import { usdToMicro } from "./money.js";
import { nowIso } from "./time.js";
import {
  assertEvent,
  parseEventPayload,
  parseObservationPayload,
  parseStringArray,
  ValidationError,
} from "./json.js";

/* ------------------------------------------------------------------ *
 * Errors
 * ------------------------------------------------------------------ */

export class StorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageError";
  }
}

/** Thrown when an event cannot be tied to a run/job without guessing. */
export class AssociationError extends StorageError {
  constructor(message: string) {
    super(message);
    this.name = "AssociationError";
  }
}

export class MigrationError extends StorageError {
  constructor(message: string) {
    super(message);
    this.name = "MigrationError";
  }
}

/* ------------------------------------------------------------------ *
 * Public record shapes (storage-local; NOT contract types)
 * ------------------------------------------------------------------ */

export interface RunRecord {
  id: string;
  status: string;
  goal: string | null;
  category: string | null;
  capMicroUsd: number;
  spentMicroUsd: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  /** Partial / failure / cancellation reason (migration 2). */
  reason: string | null;
}

export interface JobRecord {
  id: string;
  runId: string;
  purpose: LeasePurpose;
  /** Ayan-owned classification (migration 2). Null for pre-existing rows. */
  kind: JobKind | null;
  competitor: string | null;
  url: string | null;
  state: JobState;
  reason: string | null;
  createdAt: string;
  updatedAt: string;
}

export type LeasePurpose = "surface" | "reveal" | "borders" | "walker" | "setup";

/**
 * What a job IS, as opposed to what Steel session it needs.
 *
 * `benchmark` is the reason this exists: a benchmark fetch uses an external
 * tool and no Steel session, so the frozen LeaseRequest.purpose cannot name it.
 */
export type JobKind =
  | "benchmark"
  | "surface"
  | "reveal"
  | "borders"
  | "walker"
  | "setup";

export const JOB_KINDS: readonly JobKind[] = [
  "benchmark", "surface", "reveal", "borders", "walker", "setup",
];

export interface BenchmarkRecord {
  id: string;
  runId: string;
  jobId: string;
  competitor: string;
  url: string;
  urlNormalized: string;
  tool: string | null;
  vantage: Vantage;
  capturedAt: string | null;
  stale: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface RunIdempotencyRecord {
  key: string;
  runId: string;
  requestHash: string;
  createdAt: string;
}

export interface FindingRecord {
  id: string;
  runId: string;
  competitor: string;
  kind: string;
  title: string | null;
  status: FindingStatus;
  value: string | null;
  observationIds: string[];
  createdAt: string;
}

export type FindingStatus = "observed" | "verified_working" | "rejected";

export interface ArtifactRecord {
  id: string;
  sha256: string;
  path: string;
  bytes: number;
  mediaType: string | null;
  kind: string | null;
  runId: string | null;
  createdAt: string;
}

export interface StoredEvent {
  eventId: number;
  runId: string;
  jobId: string | null;
  type: Event["type"];
  createdAt: string;
  event: Event;
}

export interface PendingEmbedding {
  outboxId: number;
  observationId: string;
  runId: string;
  attempts: number;
  observation: Observation;
}

/* ------------------------------------------------------------------ *
 * Inputs
 * ------------------------------------------------------------------ */

export interface CreateRunInput {
  id: string;
  goal?: string;
  category?: string;
  capUsd?: number;
  status?: string;
  metadata?: Record<string, unknown>;
}

export interface CreateJobInput {
  id: string;
  runId: string;
  purpose: LeasePurpose;
  kind?: JobKind;
  competitor?: string;
  url?: string;
  state?: JobState;
  metadata?: Record<string, unknown>;
}

export interface CreateBenchmarkInput {
  id: string;
  runId: string;
  jobId: string;
  competitor: string;
  url: string;
  urlNormalized: string;
  vantage: Vantage;
  tool?: string;
  capturedAt?: string;
  stale?: boolean;
  metadata?: Record<string, unknown>;
}

export interface BenchmarkFilter {
  competitor?: string;
  urlNormalized?: string;
}

export interface CreateFindingInput {
  id: string;
  runId: string;
  competitor: string;
  kind: string;
  observationIds: string[];
  title?: string;
  status?: FindingStatus;
  value?: string;
  metadata?: Record<string, unknown>;
}

export interface RecordArtifactInput {
  id: string;
  sha256: string;
  path: string;
  bytes: number;
  mediaType?: string;
  kind?: string;
  runId?: string;
}

export interface ObservationFilter {
  competitor?: string;
  layer?: Layer;
  source?: Source;
  url?: string;
  kind?: Observation["kind"];
  country?: string | null;
  device?: "desktop" | "mobile";
  authenticated?: boolean;
  missedByFetch?: boolean;
  limit?: number;
  offset?: number;
}

/**
 * Association context for events whose frozen payload lacks enough data.
 *
 * Only `counter` strictly requires it: its contract carries competitor and url
 * and nothing else, and we never guess association from competitor or URL.
 */
export interface WriteContext {
  runId?: string;
  jobId?: string;
}

export type WriteOutcome =
  | { status: "written"; eventId: number; observationId?: string }
  | { status: "duplicate"; observationId: string };

export interface StorageOptions {
  /** File path, or ":memory:" for an ephemeral database. */
  path: string;
  /** Open read-only (no writes, no migrations). Default false. */
  readonly?: boolean;
  /** SQLite busy timeout in milliseconds. Default 5000. */
  busyTimeoutMs?: number;
}

/* ------------------------------------------------------------------ *
 * Row shapes as read from SQLite (unknown until validated)
 * ------------------------------------------------------------------ */

interface RunRow {
  id: string; status: string; goal: string | null; category: string | null;
  cap_micro_usd: number; spent_micro_usd: number;
  created_at: string; updated_at: string; completed_at: string | null;
  reason: string | null;
}

interface JobRow {
  id: string; run_id: string; purpose: string; kind: string | null;
  competitor: string | null;
  url: string | null; state: string; reason: string | null;
  created_at: string; updated_at: string;
}

interface BenchmarkRow {
  id: string; run_id: string; job_id: string; competitor: string;
  url: string; url_normalized: string; tool: string | null;
  vantage_country: string | null; vantage_region: string | null;
  vantage_device: string; vantage_authenticated: number;
  captured_at: string | null; stale: number;
  created_at: string; updated_at: string;
}

interface IdempotencyRow {
  key: string; run_id: string; request_hash: string; created_at: string;
}

interface FindingRow {
  id: string; run_id: string; competitor: string; kind: string;
  title: string | null; status: string; value: string | null;
  observation_ids: string; created_at: string;
}

interface ArtifactRow {
  id: string; sha256: string; path: string; bytes: number;
  media_type: string | null; kind: string | null;
  run_id: string | null; created_at: string;
}

interface EventRow {
  event_id: number; run_id: string; job_id: string | null;
  type: string; created_at: string; payload: string;
}

interface OutboxRow {
  id: number; observation_id: string; run_id: string;
  attempts: number; payload: string;
}

interface ObservationPayloadRow { payload: string }
interface CountRow { n: number }
interface VersionRow { version: number }

/* ------------------------------------------------------------------ *
 * Storage
 * ------------------------------------------------------------------ */

export class Storage {
  /** Private. There is deliberately no accessor for this. */
  readonly #db: Db;
  readonly #readonly: boolean;
  #closed = false;
  #stmts: Statements | undefined;

  private constructor(db: Db, isReadonly: boolean) {
    this.#db = db;
    this.#readonly = isReadonly;
  }

  /** Open (and create if absent) the database. Never deletes or recreates. */
  static open(options: StorageOptions): Storage {
    const { path, readonly = false, busyTimeoutMs = 5_000 } = options;

    if (path !== ":memory:" && !readonly) {
      const dir = dirname(path);
      if (dir && dir !== "." && !existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    }

    const db: Db = new Database(path, { readonly, fileMustExist: readonly && path !== ":memory:" });

    db.pragma(`busy_timeout = ${Math.trunc(busyTimeoutMs)}`);
    if (!readonly) {
      // WAL is a no-op for :memory:, which reports "memory".
      db.pragma("journal_mode = WAL");
      db.pragma("synchronous = NORMAL");
    }
    db.pragma("foreign_keys = ON");

    return new Storage(db, readonly);
  }

  /* ---------------- migrations ---------------- */

  /** Apply any unapplied migrations. Idempotent; safe to call on every boot. */
  migrate(): { from: number; to: number; applied: number[] } {
    this.#assertOpen();
    if (this.#readonly) throw new MigrationError("cannot migrate a read-only database");

    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    INTEGER PRIMARY KEY,
        name       TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);

    const currentRow = this.#db
      .prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations")
      .get() as VersionRow;
    const from = currentRow.version;

    if (from > LATEST_VERSION) {
      throw new MigrationError(
        `database schema version ${from} is newer than this build knows (${LATEST_VERSION}). ` +
          `Refusing to touch it.`,
      );
    }

    const applied: number[] = [];
    const record = this.#db.prepare(
      "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
    );

    for (const migration of MIGRATIONS) {
      if (migration.version <= from) continue;
      const run = this.#db.transaction(() => {
        this.#db.exec(migration.sql);
        record.run(migration.version, migration.name, nowIso());
      });
      try {
        run();
      } catch (cause) {
        throw new MigrationError(
          `migration ${migration.version} (${migration.name}) failed: ${(cause as Error).message}`,
        );
      }
      applied.push(migration.version);
    }

    this.#stmts = undefined; // re-prepare against the new schema
    return { from, to: LATEST_VERSION, applied };
  }

  schemaVersion(): number {
    this.#assertOpen();
    const table = this.#db
      .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='schema_migrations'")
      .get() as CountRow;
    if (table.n === 0) return 0;
    const row = this.#db
      .prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations")
      .get() as VersionRow;
    return row.version;
  }

  /* ---------------- runs ---------------- */

  createRun(input: CreateRunInput): RunRecord {
    this.#assertWritable();
    const s = this.#statements();
    const at = nowIso();
    const payload = JSON.stringify({
      id: input.id,
      goal: input.goal ?? null,
      category: input.category ?? null,
      metadata: input.metadata ?? {},
    });
    try {
      s.insertRun.run({
        id: input.id,
        status: input.status ?? "queued",
        goal: input.goal ?? null,
        category: input.category ?? null,
        cap_micro_usd: input.capUsd === undefined ? 0 : usdToMicro(input.capUsd),
        created_at: at,
        updated_at: at,
        payload,
      });
    } catch (cause) {
      throw new StorageError(`createRun(${input.id}) failed: ${(cause as Error).message}`);
    }
    const run = this.getRun(input.id);
    if (!run) throw new StorageError(`createRun(${input.id}) did not persist`);
    return run;
  }

  getRun(id: string): RunRecord | null {
    this.#assertOpen();
    const row = this.#statements().selectRun.get(id) as RunRow | undefined;
    return row ? mapRun(row) : null;
  }

  /** Authoritative spend for a run: the integer sum of receipt micro-dollars. */
  runSpendMicroUsd(runId: string): number {
    this.#assertOpen();
    const row = this.#statements().sumReceipts.get(runId) as CountRow;
    return row.n;
  }

  /* ---------------- jobs ---------------- */

  createJob(input: CreateJobInput): JobRecord {
    this.#assertWritable();
    const s = this.#statements();
    const at = nowIso();
    if (input.kind !== undefined && !JOB_KINDS.includes(input.kind)) {
      throw new StorageError(`createJob(${input.id}): unknown kind ${input.kind}`);
    }
    try {
      s.insertJob.run({
        id: input.id,
        run_id: input.runId,
        purpose: input.purpose,
        kind: input.kind ?? null,
        competitor: input.competitor ?? null,
        url: input.url ?? null,
        state: input.state ?? "queued",
        created_at: at,
        updated_at: at,
        payload: JSON.stringify({ id: input.id, metadata: input.metadata ?? {} }),
      });
    } catch (cause) {
      throw new StorageError(`createJob(${input.id}) failed: ${(cause as Error).message}`);
    }
    const job = this.getJob(input.id);
    if (!job) throw new StorageError(`createJob(${input.id}) did not persist`);
    return job;
  }

  /* ---------------- run status ---------------- */

  /**
   * Set a run's status directly (cancellation, partial, failure).
   * Terminal runs are not re-transitioned; the caller sees `changed: false`.
   */
  setRunStatus(
    runId: string,
    status: string,
    reason?: string,
  ): { changed: boolean; run: RunRecord } {
    this.#assertWritable();
    const run = this.getRun(runId);
    if (!run) throw new AssociationError(`setRunStatus references unknown run ${runId}`);
    if (run.status === status) return { changed: false, run };

    const at = nowIso();
    const terminal = status === "completed" || status === "cancelled" || status === "failed";
    this.#statements().setRunStatus.run({
      id: runId,
      status,
      reason: reason ?? run.reason,
      updated_at: at,
      completed_at: terminal ? (run.completedAt ?? at) : run.completedAt,
    });
    const updated = this.getRun(runId);
    if (!updated) throw new StorageError(`setRunStatus(${runId}) lost the run`);
    return { changed: true, run: updated };
  }

  /* ---------------- benchmarks ---------------- */

  /** Record a benchmark execution. Idempotent on (run, competitor, url, vantage). */
  upsertBenchmark(input: CreateBenchmarkInput): BenchmarkRecord {
    this.#assertWritable();
    const s = this.#statements();
    const job = this.getJob(input.jobId);
    if (!job) throw new AssociationError(`benchmark references unknown job ${input.jobId}`);
    if (job.runId !== input.runId) {
      throw new AssociationError(
        `benchmark claims run ${input.runId} but job ${input.jobId} belongs to ${job.runId}`,
      );
    }

    const at = nowIso();
    try {
      s.upsertBenchmark.run({
        id: input.id,
        run_id: input.runId,
        job_id: input.jobId,
        competitor: input.competitor,
        url: input.url,
        url_normalized: input.urlNormalized,
        tool: input.tool ?? null,
        vantage_country: input.vantage.country,
        vantage_region: input.vantage.region ?? null,
        vantage_device: input.vantage.device,
        vantage_authenticated: input.vantage.authenticated ? 1 : 0,
        captured_at: input.capturedAt ?? null,
        stale: input.stale ? 1 : 0,
        created_at: at,
        updated_at: at,
        payload: JSON.stringify({ id: input.id, metadata: input.metadata ?? {} }),
      });
    } catch (cause) {
      throw new StorageError(`upsertBenchmark(${input.id}) failed: ${(cause as Error).message}`);
    }

    const record = this.getBenchmark(input.id);
    if (!record) throw new StorageError(`upsertBenchmark(${input.id}) did not persist`);
    return record;
  }

  getBenchmark(id: string): BenchmarkRecord | null {
    this.#assertOpen();
    const row = this.#statements().selectBenchmark.get(id) as BenchmarkRow | undefined;
    return row ? mapBenchmark(row) : null;
  }

  getBenchmarksByRun(runId: string, filter: BenchmarkFilter = {}): BenchmarkRecord[] {
    this.#assertOpen();
    const s = this.#statements();
    const rows = (
      filter.competitor !== undefined && filter.urlNormalized !== undefined
        ? s.selectBenchmarksByUrl.all(runId, filter.competitor, filter.urlNormalized)
        : filter.competitor !== undefined
          ? s.selectBenchmarksByCompetitor.all(runId, filter.competitor)
          : s.selectBenchmarksByRun.all(runId)
    ) as BenchmarkRow[];
    return rows.map(mapBenchmark);
  }

  /* ---------------- run idempotency ---------------- */

  getRunIdempotency(key: string): RunIdempotencyRecord | null {
    this.#assertOpen();
    const row = this.#statements().selectIdempotency.get(key) as IdempotencyRow | undefined;
    return row
      ? { key: row.key, runId: row.run_id, requestHash: row.request_hash, createdAt: row.created_at }
      : null;
  }

  recordRunIdempotency(key: string, runId: string, requestHash: string): RunIdempotencyRecord {
    this.#assertWritable();
    try {
      this.#statements().insertIdempotency.run({
        key, run_id: runId, request_hash: requestHash, created_at: nowIso(),
      });
    } catch (cause) {
      throw new StorageError(`recordRunIdempotency(${key}) failed: ${(cause as Error).message}`);
    }
    const record = this.getRunIdempotency(key);
    if (!record) throw new StorageError(`recordRunIdempotency(${key}) did not persist`);
    return record;
  }

  getJob(id: string): JobRecord | null {
    this.#assertOpen();
    const row = this.#statements().selectJob.get(id) as JobRow | undefined;
    return row ? mapJob(row) : null;
  }

  getJobsByRun(runId: string): JobRecord[] {
    this.#assertOpen();
    const rows = this.#statements().selectJobsByRun.all(runId) as JobRow[];
    return rows.map(mapJob);
  }

  /* ---------------- the write path ---------------- */

  /**
   * Persist one frozen contract event.
   *
   * Association rules:
   *   - resolve the run directly from `runId` when the payload has one;
   *   - otherwise resolve it through an existing `jobId`;
   *   - `counter` has neither, so it REQUIRES explicit context;
   *   - competitor/url are never used to guess association.
   *
   * Returns `{status:"duplicate"}` for an observation id already stored; in
   * that case nothing at all is written — no event, no outbox row.
   */
  write(event: Event, context?: WriteContext): WriteOutcome {
    this.#assertWritable();
    assertEvent(event);
    const s = this.#statements();

    switch (event.type) {
      case "observation":
        return this.#writeObservation(event, event.data, s);
      case "receipt":
        return this.#writeReceipt(event, event.data, s, context);
      case "job_state":
        return this.#writeJobState(event, event.data, s, context);
      case "handoff":
        return this.#writeHandoff(event, event.data, s, context);
      case "counter":
        return this.#writeCounter(event, s, context);
      case "spend":
        return this.#writeSpend(event, event.data, s);
      case "run_done":
        return this.#writeRunDone(event, event.data, s);
      default: {
        const exhaustive: never = event;
        throw new StorageError(`unhandled event type: ${JSON.stringify(exhaustive)}`);
      }
    }
  }

  #writeObservation(event: Event, obs: Observation, s: Statements): WriteOutcome {
    const job = this.getJob(obs.jobId);
    if (!job) {
      throw new AssociationError(
        `observation ${obs.id} references unknown job ${obs.jobId}`,
      );
    }
    if (job.runId !== obs.runId) {
      throw new AssociationError(
        `observation ${obs.id} claims run ${obs.runId} but job ${obs.jobId} belongs to run ${job.runId}`,
      );
    }

    const at = nowIso();
    const payload = JSON.stringify(obs);
    const eventPayload = JSON.stringify(event);

    const tx = this.#db.transaction((): WriteOutcome => {
      const inserted = s.insertObservation.run({
        id: obs.id,
        run_id: obs.runId,
        job_id: obs.jobId,
        competitor: obs.competitor,
        url: obs.url,
        layer: obs.layer,
        source: obs.source,
        kind: obs.kind,
        text: obs.text,
        perception: obs.perception,
        missed_by_fetch: obs.missedByFetch === undefined ? null : obs.missedByFetch ? 1 : 0,
        revealed_by_action: obs.revealedBy?.action ?? null,
        revealed_by_label: obs.revealedBy?.label ?? null,
        vantage_country: obs.vantage.country,
        vantage_region: obs.vantage.region ?? null,
        vantage_device: obs.vantage.device,
        vantage_authenticated: obs.vantage.authenticated ? 1 : 0,
        screenshot_path: obs.screenshotPath ?? null,
        steel_session_id: obs.steelSessionId ?? null,
        viewer_url: obs.viewerUrl ?? null,
        trace_start: obs.traceRange?.start ?? null,
        trace_end: obs.traceRange?.end ?? null,
        captured_at: obs.capturedAt,
        created_at: at,
        payload,
      });

      // Deterministic id already present: reject without side effects.
      if (inserted.changes === 0) {
        return { status: "duplicate", observationId: obs.id };
      }

      const ev = s.insertEvent.run({
        run_id: obs.runId,
        job_id: obs.jobId,
        type: "observation",
        observation_id: obs.id,
        created_at: at,
        payload: eventPayload,
      });

      s.insertOutbox.run({
        observation_id: obs.id,
        run_id: obs.runId,
        created_at: at,
        updated_at: at,
      });

      return {
        status: "written",
        eventId: Number(ev.lastInsertRowid),
        observationId: obs.id,
      };
    });

    return tx();
  }

  #writeReceipt(
    event: Event,
    receipt: ActionReceipt,
    s: Statements,
    context: WriteContext | undefined,
  ): WriteOutcome {
    const job = this.#resolveJob(receipt.jobId, context, "receipt");
    const microUsd = usdToMicro(receipt.usd);
    const at = nowIso();
    const eventPayload = JSON.stringify(event);
    const payload = JSON.stringify(receipt);

    const tx = this.#db.transaction((): WriteOutcome => {
      const ev = s.insertEvent.run({
        run_id: job.runId,
        job_id: job.id,
        type: "receipt",
        observation_id: null,
        created_at: at,
        payload: eventPayload,
      });
      const eventId = Number(ev.lastInsertRowid);

      s.insertReceipt.run({
        run_id: job.runId,
        job_id: job.id,
        step: receipt.step,
        action: receipt.action,
        target: receipt.target ?? null,
        before: receipt.before,
        after: receipt.after,
        ok: receipt.ok ? 1 : 0,
        tokens_in: Math.trunc(receipt.tokensIn),
        tokens_out: Math.trunc(receipt.tokensOut),
        micro_usd: microUsd,
        event_id: eventId,
        created_at: at,
        payload,
      });

      // Integer-only accumulation. Never sums floats.
      s.addRunSpend.run({ run_id: job.runId, micro_usd: microUsd, updated_at: at });

      return { status: "written", eventId };
    });

    return tx();
  }

  #writeJobState(
    event: Event,
    data: { jobId: string; state: JobState; reason?: string },
    s: Statements,
    context: WriteContext | undefined,
  ): WriteOutcome {
    const job = this.#resolveJob(data.jobId, context, "job_state");
    const at = nowIso();
    const eventPayload = JSON.stringify(event);

    const tx = this.#db.transaction((): WriteOutcome => {
      const updated = s.updateJobState.run({
        id: job.id,
        state: data.state,
        reason: data.reason ?? null,
        updated_at: at,
      });
      if (updated.changes !== 1) {
        throw new StorageError(`job ${job.id} disappeared during transition`);
      }
      const ev = s.insertEvent.run({
        run_id: job.runId,
        job_id: job.id,
        type: "job_state",
        observation_id: null,
        created_at: at,
        payload: eventPayload,
      });
      return { status: "written", eventId: Number(ev.lastInsertRowid) };
    });

    return tx();
  }

  #writeHandoff(
    event: Event,
    data: { jobId: string },
    s: Statements,
    context: WriteContext | undefined,
  ): WriteOutcome {
    const job = this.#resolveJob(data.jobId, context, "handoff");
    const at = nowIso();
    const eventPayload = JSON.stringify(event);

    const tx = this.#db.transaction((): WriteOutcome => {
      const ev = s.insertEvent.run({
        run_id: job.runId,
        job_id: job.id,
        type: "handoff",
        observation_id: null,
        created_at: at,
        payload: eventPayload,
      });
      return { status: "written", eventId: Number(ev.lastInsertRowid) };
    });

    return tx();
  }

  #writeCounter(event: Event, s: Statements, context: WriteContext | undefined): WriteOutcome {
    // The frozen counter payload carries competitor and url only. We do not
    // guess association from either. Explicit context is mandatory.
    const runId = this.#resolveRunFromContext(context, "counter");
    const jobId = context?.jobId ?? null;
    const at = nowIso();
    const eventPayload = JSON.stringify(event);

    const tx = this.#db.transaction((): WriteOutcome => {
      const ev = s.insertEvent.run({
        run_id: runId,
        job_id: jobId,
        type: "counter",
        observation_id: null,
        created_at: at,
        payload: eventPayload,
      });
      return { status: "written", eventId: Number(ev.lastInsertRowid) };
    });

    return tx();
  }

  #writeSpend(
    event: Event,
    data: { runId: string; usd: number; cap: number },
    s: Statements,
  ): WriteOutcome {
    const run = this.getRun(data.runId);
    if (!run) throw new AssociationError(`spend event references unknown run ${data.runId}`);

    const microUsd = usdToMicro(data.usd);
    const capMicroUsd = usdToMicro(data.cap);
    const at = nowIso();
    const eventPayload = JSON.stringify(event);

    const tx = this.#db.transaction((): WriteOutcome => {
      const ev = s.insertEvent.run({
        run_id: run.id,
        job_id: null,
        type: "spend",
        observation_id: null,
        created_at: at,
        payload: eventPayload,
      });
      const eventId = Number(ev.lastInsertRowid);
      s.insertSpend.run({
        run_id: run.id,
        micro_usd: microUsd,
        cap_micro_usd: capMicroUsd,
        event_id: eventId,
        created_at: at,
        payload: JSON.stringify(data),
      });
      s.updateRunCap.run({ id: run.id, cap_micro_usd: capMicroUsd, updated_at: at });
      return { status: "written", eventId };
    });

    return tx();
  }

  #writeRunDone(event: Event, data: { runId: string }, s: Statements): WriteOutcome {
    const run = this.getRun(data.runId);
    if (!run) throw new AssociationError(`run_done event references unknown run ${data.runId}`);
    const at = nowIso();
    const eventPayload = JSON.stringify(event);

    const tx = this.#db.transaction((): WriteOutcome => {
      s.completeRun.run({ id: run.id, completed_at: at, updated_at: at });
      const ev = s.insertEvent.run({
        run_id: run.id,
        job_id: null,
        type: "run_done",
        observation_id: null,
        created_at: at,
        payload: eventPayload,
      });
      return { status: "written", eventId: Number(ev.lastInsertRowid) };
    });

    return tx();
  }

  /* ---------------- findings ---------------- */

  /** Create a finding. Evidence is mandatory and must already exist. */
  createFinding(input: CreateFindingInput): FindingRecord {
    this.#assertWritable();
    const s = this.#statements();

    if (input.observationIds.length === 0) {
      throw new StorageError(`finding ${input.id} rejected: no evidence observation ids`);
    }
    const unique = [...new Set(input.observationIds)];
    const at = nowIso();

    const tx = this.#db.transaction(() => {
      s.insertFinding.run({
        id: input.id,
        run_id: input.runId,
        competitor: input.competitor,
        kind: input.kind,
        title: input.title ?? null,
        status: input.status ?? "observed",
        value: input.value ?? null,
        observation_ids: JSON.stringify(unique),
        created_at: at,
        payload: JSON.stringify({ id: input.id, metadata: input.metadata ?? {} }),
      });
      for (const observationId of unique) {
        // FK to observations makes unknown evidence fail the whole transaction.
        s.insertFindingObservation.run({ finding_id: input.id, observation_id: observationId });
      }
    });

    try {
      tx();
    } catch (cause) {
      throw new StorageError(`createFinding(${input.id}) failed: ${(cause as Error).message}`);
    }

    const finding = this.getFinding(input.id);
    if (!finding) throw new StorageError(`createFinding(${input.id}) did not persist`);
    return finding;
  }

  getFinding(id: string): FindingRecord | null {
    this.#assertOpen();
    const row = this.#statements().selectFinding.get(id) as FindingRow | undefined;
    return row ? mapFinding(row) : null;
  }

  getFindingsByRun(runId: string, kind?: string): FindingRecord[] {
    this.#assertOpen();
    const s = this.#statements();
    const rows = (
      kind === undefined
        ? s.selectFindingsByRun.all(runId)
        : s.selectFindingsByRunKind.all(runId, kind)
    ) as FindingRow[];
    return rows.map(mapFinding);
  }

  /* ---------------- observations (read) ---------------- */

  getObservation(id: string): Observation | null {
    this.#assertOpen();
    const row = this.#statements().selectObservation.get(id) as
      | ObservationPayloadRow
      | undefined;
    return row ? parseObservationPayload(row.payload, `observation(${id})`) : null;
  }

  getObservationsByRun(runId: string, filter: ObservationFilter = {}): Observation[] {
    this.#assertOpen();

    const where: string[] = ["run_id = @run_id"];
    const params: Record<string, unknown> = { run_id: runId };

    if (filter.competitor !== undefined) { where.push("competitor = @competitor"); params["competitor"] = filter.competitor; }
    if (filter.layer !== undefined)      { where.push("layer = @layer");           params["layer"] = filter.layer; }
    if (filter.source !== undefined)     { where.push("source = @source");         params["source"] = filter.source; }
    if (filter.url !== undefined)        { where.push("url = @url");               params["url"] = filter.url; }
    if (filter.kind !== undefined)       { where.push("kind = @kind");             params["kind"] = filter.kind; }
    if (filter.device !== undefined)     { where.push("vantage_device = @device"); params["device"] = filter.device; }
    if (filter.authenticated !== undefined) {
      where.push("vantage_authenticated = @authenticated");
      params["authenticated"] = filter.authenticated ? 1 : 0;
    }
    if (filter.country !== undefined) {
      if (filter.country === null) {
        where.push("vantage_country IS NULL");
      } else {
        where.push("vantage_country = @country");
        params["country"] = filter.country;
      }
    }
    if (filter.missedByFetch !== undefined) {
      where.push("missed_by_fetch = @missed");
      params["missed"] = filter.missedByFetch ? 1 : 0;
    }

    const limit = filter.limit ?? -1;
    const offset = filter.offset ?? 0;
    params["limit"] = limit;
    params["offset"] = offset;

    const sql =
      `SELECT payload FROM observations WHERE ${where.join(" AND ")} ` +
      `ORDER BY captured_at ASC, id ASC LIMIT @limit OFFSET @offset`;

    const rows = this.#db.prepare(sql).all(params) as ObservationPayloadRow[];
    return rows.map((row, i) => parseObservationPayload(row.payload, `observations[${i}]`));
  }

  countObservations(runId?: string): number {
    this.#assertOpen();
    const s = this.#statements();
    const row = (runId === undefined
      ? s.countObservations.get()
      : s.countObservationsByRun.get(runId)) as CountRow;
    return row.n;
  }

  /** Stream every observation, oldest first. Used by corpus rebuild. */
  *iterateObservations(runId?: string): Generator<Observation, void, undefined> {
    this.#assertOpen();
    const sql = runId === undefined
      ? "SELECT payload FROM observations ORDER BY created_at ASC, id ASC"
      : "SELECT payload FROM observations WHERE run_id = ? ORDER BY created_at ASC, id ASC";
    const stmt = this.#db.prepare(sql);
    const rows = runId === undefined ? stmt.iterate() : stmt.iterate(runId);
    let index = 0;
    for (const row of rows) {
      const typed = row as ObservationPayloadRow;
      yield parseObservationPayload(typed.payload, `observations[${index}]`);
      index += 1;
    }
  }

  /* ---------------- events (ordered replay) ---------------- */

  /** Ordered events after `lastEventId`. `0` starts from the beginning. */
  readEventsAfter(runId: string, lastEventId = 0, limit = 500): StoredEvent[] {
    this.#assertOpen();
    const rows = this.#statements().selectEventsAfter.all({
      run_id: runId,
      after: lastEventId,
      limit,
    }) as EventRow[];
    return rows.map((row) => ({
      eventId: row.event_id,
      runId: row.run_id,
      jobId: row.job_id,
      type: row.type as Event["type"],
      createdAt: row.created_at,
      event: parseEventPayload(row.payload, `event(${row.event_id})`),
    }));
  }

  countEvents(runId: string, type?: Event["type"]): number {
    this.#assertOpen();
    const s = this.#statements();
    const row = (type === undefined
      ? s.countEventsByRun.get(runId)
      : s.countEventsByRunType.get(runId, type)) as CountRow;
    return row.n;
  }

  /* ---------------- embedding outbox ---------------- */

  /**
   * Pending embedding work. Read in a short transaction; the caller embeds
   * OUTSIDE any transaction and then calls markEmbedded / markEmbeddingFailed.
   */
  pendingEmbeddings(limit = 128, maxAttempts = 5): PendingEmbedding[] {
    this.#assertOpen();
    const rows = this.#statements().selectPendingOutbox.all({
      limit,
      max_attempts: maxAttempts,
    }) as OutboxRow[];
    return rows.map((row) => ({
      outboxId: row.id,
      observationId: row.observation_id,
      runId: row.run_id,
      attempts: row.attempts,
      observation: parseObservationPayload(row.payload, `outbox(${row.observation_id})`),
    }));
  }

  countPendingEmbeddings(maxAttempts = 5): number {
    this.#assertOpen();
    const row = this.#statements().countPendingOutbox.get({ max_attempts: maxAttempts }) as CountRow;
    return row.n;
  }

  markEmbedded(observationIds: readonly string[]): number {
    this.#assertWritable();
    if (observationIds.length === 0) return 0;
    const s = this.#statements();
    const at = nowIso();
    const tx = this.#db.transaction((ids: readonly string[]): number => {
      let changed = 0;
      for (const id of ids) {
        changed += s.markOutboxDone.run({ observation_id: id, updated_at: at }).changes;
      }
      return changed;
    });
    return tx(observationIds);
  }

  markEmbeddingFailed(observationId: string, error: string): void {
    this.#assertWritable();
    this.#statements().markOutboxFailed.run({
      observation_id: observationId,
      last_error: error.slice(0, 2_000),
      updated_at: nowIso(),
    });
  }

  /** Re-queue every outbox row (used before a full rebuild). */
  resetEmbeddingOutbox(runId?: string): number {
    this.#assertWritable();
    const s = this.#statements();
    const at = nowIso();
    const result = runId === undefined
      ? s.resetOutboxAll.run({ updated_at: at })
      : s.resetOutboxRun.run({ run_id: runId, updated_at: at });
    return result.changes;
  }

  /* ---------------- artifacts ---------------- */

  /** Persist artifact metadata. Called by artifacts.ts; deduplicates on sha256. */
  recordArtifact(input: RecordArtifactInput): ArtifactRecord {
    this.#assertWritable();
    const s = this.#statements();
    const existing = this.getArtifactBySha256(input.sha256);
    if (existing) return existing;

    try {
      s.insertArtifact.run({
        id: input.id,
        sha256: input.sha256,
        path: input.path,
        bytes: input.bytes,
        media_type: input.mediaType ?? null,
        kind: input.kind ?? null,
        run_id: input.runId ?? null,
        created_at: nowIso(),
      });
    } catch (cause) {
      throw new StorageError(`recordArtifact(${input.id}) failed: ${(cause as Error).message}`);
    }
    const record = this.getArtifact(input.id);
    if (!record) throw new StorageError(`recordArtifact(${input.id}) did not persist`);
    return record;
  }

  getArtifact(id: string): ArtifactRecord | null {
    this.#assertOpen();
    const row = this.#statements().selectArtifact.get(id) as ArtifactRow | undefined;
    return row ? mapArtifact(row) : null;
  }

  getArtifactBySha256(sha256: string): ArtifactRecord | null {
    this.#assertOpen();
    const row = this.#statements().selectArtifactBySha.get(sha256) as ArtifactRow | undefined;
    return row ? mapArtifact(row) : null;
  }

  /* ---------------- lifecycle ---------------- */

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#stmts = undefined;
    this.#db.close();
  }

  get closed(): boolean {
    return this.#closed;
  }

  /* ---------------- internals ---------------- */

  #assertOpen(): void {
    if (this.#closed) throw new StorageError("storage is closed");
  }

  #assertWritable(): void {
    this.#assertOpen();
    if (this.#readonly) throw new StorageError("storage is read-only");
  }

  #resolveJob(jobId: string, context: WriteContext | undefined, what: string): JobRecord {
    const id = jobId || context?.jobId;
    if (!id) {
      throw new AssociationError(`${what} event has no jobId and no context.jobId`);
    }
    const job = this.getJob(id);
    if (!job) throw new AssociationError(`${what} event references unknown job ${id}`);
    if (context?.runId !== undefined && context.runId !== job.runId) {
      throw new AssociationError(
        `${what} context claims run ${context.runId} but job ${id} belongs to run ${job.runId}`,
      );
    }
    return job;
  }

  #resolveRunFromContext(context: WriteContext | undefined, what: string): string {
    if (context?.runId !== undefined) {
      const run = this.getRun(context.runId);
      if (!run) throw new AssociationError(`${what} context references unknown run ${context.runId}`);
      return run.id;
    }
    if (context?.jobId !== undefined) {
      const job = this.getJob(context.jobId);
      if (!job) throw new AssociationError(`${what} context references unknown job ${context.jobId}`);
      return job.runId;
    }
    throw new AssociationError(
      `${what} event carries no run or job association; pass WriteContext ` +
        `{ runId } or { jobId }. Competitor and URL are never used to guess.`,
    );
  }

  #statements(): Statements {
    this.#assertOpen();
    if (!this.#stmts) this.#stmts = prepareStatements(this.#db);
    return this.#stmts;
  }
}

/* ------------------------------------------------------------------ *
 * Row mappers
 * ------------------------------------------------------------------ */

function mapRun(row: RunRow): RunRecord {
  return {
    id: row.id,
    status: row.status,
    goal: row.goal,
    category: row.category,
    capMicroUsd: row.cap_micro_usd,
    spentMicroUsd: row.spent_micro_usd,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    reason: row.reason ?? null,
  };
}

function mapJob(row: JobRow): JobRecord {
  return {
    id: row.id,
    runId: row.run_id,
    purpose: row.purpose as LeasePurpose,
    kind: (row.kind as JobKind | null) ?? null,
    competitor: row.competitor,
    url: row.url,
    state: row.state as JobState,
    reason: row.reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapBenchmark(row: BenchmarkRow): BenchmarkRecord {
  return {
    id: row.id,
    runId: row.run_id,
    jobId: row.job_id,
    competitor: row.competitor,
    url: row.url,
    urlNormalized: row.url_normalized,
    tool: row.tool,
    vantage: {
      country: row.vantage_country,
      region: row.vantage_region,
      device: row.vantage_device as Vantage["device"],
      authenticated: row.vantage_authenticated === 1,
    },
    capturedAt: row.captured_at,
    stale: row.stale === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapFinding(row: FindingRow): FindingRecord {
  return {
    id: row.id,
    runId: row.run_id,
    competitor: row.competitor,
    kind: row.kind,
    title: row.title,
    status: row.status as FindingStatus,
    value: row.value,
    observationIds: parseStringArray(row.observation_ids, `finding(${row.id}).observation_ids`),
    createdAt: row.created_at,
  };
}

function mapArtifact(row: ArtifactRow): ArtifactRecord {
  return {
    id: row.id,
    sha256: row.sha256,
    path: row.path,
    bytes: row.bytes,
    mediaType: row.media_type,
    kind: row.kind,
    runId: row.run_id,
    createdAt: row.created_at,
  };
}

/* ------------------------------------------------------------------ *
 * Prepared statements
 * ------------------------------------------------------------------ */

interface Statements {
  insertRun: Statement;
  selectRun: Statement;
  updateRunCap: Statement;
  completeRun: Statement;
  addRunSpend: Statement;
  sumReceipts: Statement;

  insertJob: Statement;
  selectJob: Statement;
  selectJobsByRun: Statement;
  updateJobState: Statement;
  setRunStatus: Statement;

  upsertBenchmark: Statement;
  selectBenchmark: Statement;
  selectBenchmarksByRun: Statement;
  selectBenchmarksByCompetitor: Statement;
  selectBenchmarksByUrl: Statement;

  insertIdempotency: Statement;
  selectIdempotency: Statement;

  insertEvent: Statement;
  selectEventsAfter: Statement;
  countEventsByRun: Statement;
  countEventsByRunType: Statement;

  insertObservation: Statement;
  selectObservation: Statement;
  countObservations: Statement;
  countObservationsByRun: Statement;

  insertReceipt: Statement;
  insertSpend: Statement;

  insertFinding: Statement;
  insertFindingObservation: Statement;
  selectFinding: Statement;
  selectFindingsByRun: Statement;
  selectFindingsByRunKind: Statement;

  insertOutbox: Statement;
  selectPendingOutbox: Statement;
  countPendingOutbox: Statement;
  markOutboxDone: Statement;
  markOutboxFailed: Statement;
  resetOutboxAll: Statement;
  resetOutboxRun: Statement;

  insertArtifact: Statement;
  selectArtifact: Statement;
  selectArtifactBySha: Statement;
}

function prepareStatements(db: Db): Statements {
  return {
    insertRun: db.prepare(`
      INSERT INTO runs (id, status, goal, category, cap_micro_usd, spent_micro_usd,
                        created_at, updated_at, payload)
      VALUES (@id, @status, @goal, @category, @cap_micro_usd, 0,
              @created_at, @updated_at, @payload)`),
    selectRun: db.prepare(`SELECT * FROM runs WHERE id = ?`),
    updateRunCap: db.prepare(`
      UPDATE runs SET cap_micro_usd = @cap_micro_usd, updated_at = @updated_at WHERE id = @id`),
    completeRun: db.prepare(`
      UPDATE runs SET status = 'completed', completed_at = @completed_at,
                      updated_at = @updated_at WHERE id = @id`),
    addRunSpend: db.prepare(`
      UPDATE runs SET spent_micro_usd = spent_micro_usd + @micro_usd,
                      updated_at = @updated_at WHERE id = @run_id`),
    sumReceipts: db.prepare(`
      SELECT COALESCE(SUM(micro_usd), 0) AS n FROM receipts WHERE run_id = ?`),

    insertJob: db.prepare(`
      INSERT INTO jobs (id, run_id, purpose, kind, competitor, url, state,
                        created_at, updated_at, payload)
      VALUES (@id, @run_id, @purpose, @kind, @competitor, @url, @state,
              @created_at, @updated_at, @payload)`),
    selectJob: db.prepare(`SELECT * FROM jobs WHERE id = ?`),
    selectJobsByRun: db.prepare(`SELECT * FROM jobs WHERE run_id = ? ORDER BY created_at ASC, id ASC`),
    updateJobState: db.prepare(`
      UPDATE jobs SET state = @state, reason = @reason, updated_at = @updated_at WHERE id = @id`),
    setRunStatus: db.prepare(`
      UPDATE runs SET status = @status, reason = @reason, updated_at = @updated_at,
                      completed_at = @completed_at WHERE id = @id`),

    upsertBenchmark: db.prepare(`
      INSERT INTO benchmarks (id, run_id, job_id, competitor, url, url_normalized, tool,
                              vantage_country, vantage_region, vantage_device,
                              vantage_authenticated, captured_at, stale,
                              created_at, updated_at, payload)
      VALUES (@id, @run_id, @job_id, @competitor, @url, @url_normalized, @tool,
              @vantage_country, @vantage_region, @vantage_device,
              @vantage_authenticated, @captured_at, @stale,
              @created_at, @updated_at, @payload)
      ON CONFLICT (run_id, competitor, url_normalized, vantage_country, vantage_region,
                   vantage_device, vantage_authenticated)
      DO UPDATE SET job_id = excluded.job_id, tool = excluded.tool,
                    captured_at = excluded.captured_at, stale = excluded.stale,
                    updated_at = excluded.updated_at, payload = excluded.payload`),
    selectBenchmark: db.prepare(`SELECT * FROM benchmarks WHERE id = ?`),
    selectBenchmarksByRun: db.prepare(`
      SELECT * FROM benchmarks WHERE run_id = ? ORDER BY created_at ASC, id ASC`),
    selectBenchmarksByCompetitor: db.prepare(`
      SELECT * FROM benchmarks WHERE run_id = ? AND competitor = ?
      ORDER BY created_at ASC, id ASC`),
    selectBenchmarksByUrl: db.prepare(`
      SELECT * FROM benchmarks WHERE run_id = ? AND competitor = ? AND url_normalized = ?
      ORDER BY created_at ASC, id ASC`),

    insertIdempotency: db.prepare(`
      INSERT INTO run_idempotency (key, run_id, request_hash, created_at)
      VALUES (@key, @run_id, @request_hash, @created_at)`),
    selectIdempotency: db.prepare(`SELECT * FROM run_idempotency WHERE key = ?`),

    insertEvent: db.prepare(`
      INSERT INTO events (run_id, job_id, type, observation_id, created_at, payload)
      VALUES (@run_id, @job_id, @type, @observation_id, @created_at, @payload)`),
    selectEventsAfter: db.prepare(`
      SELECT * FROM events WHERE run_id = @run_id AND event_id > @after
      ORDER BY event_id ASC LIMIT @limit`),
    countEventsByRun: db.prepare(`SELECT COUNT(*) AS n FROM events WHERE run_id = ?`),
    countEventsByRunType: db.prepare(`SELECT COUNT(*) AS n FROM events WHERE run_id = ? AND type = ?`),

    insertObservation: db.prepare(`
      INSERT INTO observations (
        id, run_id, job_id, competitor, url, layer, source, kind, text, perception,
        missed_by_fetch, revealed_by_action, revealed_by_label,
        vantage_country, vantage_region, vantage_device, vantage_authenticated,
        screenshot_path, steel_session_id, viewer_url, trace_start, trace_end,
        captured_at, created_at, payload)
      VALUES (
        @id, @run_id, @job_id, @competitor, @url, @layer, @source, @kind, @text, @perception,
        @missed_by_fetch, @revealed_by_action, @revealed_by_label,
        @vantage_country, @vantage_region, @vantage_device, @vantage_authenticated,
        @screenshot_path, @steel_session_id, @viewer_url, @trace_start, @trace_end,
        @captured_at, @created_at, @payload)
      ON CONFLICT (id) DO NOTHING`),
    selectObservation: db.prepare(`SELECT payload FROM observations WHERE id = ?`),
    countObservations: db.prepare(`SELECT COUNT(*) AS n FROM observations`),
    countObservationsByRun: db.prepare(`SELECT COUNT(*) AS n FROM observations WHERE run_id = ?`),

    insertReceipt: db.prepare(`
      INSERT INTO receipts (run_id, job_id, step, action, target, before, after, ok,
                            tokens_in, tokens_out, micro_usd, event_id, created_at, payload)
      VALUES (@run_id, @job_id, @step, @action, @target, @before, @after, @ok,
              @tokens_in, @tokens_out, @micro_usd, @event_id, @created_at, @payload)`),
    insertSpend: db.prepare(`
      INSERT INTO spend (run_id, micro_usd, cap_micro_usd, event_id, created_at, payload)
      VALUES (@run_id, @micro_usd, @cap_micro_usd, @event_id, @created_at, @payload)`),

    insertFinding: db.prepare(`
      INSERT INTO findings (id, run_id, competitor, kind, title, status, value,
                            observation_ids, created_at, payload)
      VALUES (@id, @run_id, @competitor, @kind, @title, @status, @value,
              @observation_ids, @created_at, @payload)`),
    insertFindingObservation: db.prepare(`
      INSERT INTO finding_observations (finding_id, observation_id)
      VALUES (@finding_id, @observation_id)`),
    selectFinding: db.prepare(`SELECT * FROM findings WHERE id = ?`),
    selectFindingsByRun: db.prepare(`
      SELECT * FROM findings WHERE run_id = ? ORDER BY created_at ASC, id ASC`),
    selectFindingsByRunKind: db.prepare(`
      SELECT * FROM findings WHERE run_id = ? AND kind = ? ORDER BY created_at ASC, id ASC`),

    insertOutbox: db.prepare(`
      INSERT INTO embedding_outbox (observation_id, run_id, status, attempts, created_at, updated_at)
      VALUES (@observation_id, @run_id, 'pending', 0, @created_at, @updated_at)
      ON CONFLICT (observation_id) DO NOTHING`),
    selectPendingOutbox: db.prepare(`
      SELECT o.id, o.observation_id, o.run_id, o.attempts, obs.payload
      FROM embedding_outbox o
      JOIN observations obs ON obs.id = o.observation_id
      WHERE o.status = 'pending' OR (o.status = 'failed' AND o.attempts < @max_attempts)
      ORDER BY o.id ASC LIMIT @limit`),
    countPendingOutbox: db.prepare(`
      SELECT COUNT(*) AS n FROM embedding_outbox
      WHERE status = 'pending' OR (status = 'failed' AND attempts < @max_attempts)`),
    markOutboxDone: db.prepare(`
      UPDATE embedding_outbox SET status = 'done', last_error = NULL, updated_at = @updated_at
      WHERE observation_id = @observation_id`),
    markOutboxFailed: db.prepare(`
      UPDATE embedding_outbox SET status = 'failed', attempts = attempts + 1,
             last_error = @last_error, updated_at = @updated_at
      WHERE observation_id = @observation_id`),
    resetOutboxAll: db.prepare(`
      UPDATE embedding_outbox SET status = 'pending', attempts = 0, last_error = NULL,
             updated_at = @updated_at`),
    resetOutboxRun: db.prepare(`
      UPDATE embedding_outbox SET status = 'pending', attempts = 0, last_error = NULL,
             updated_at = @updated_at WHERE run_id = @run_id`),

    insertArtifact: db.prepare(`
      INSERT INTO artifacts (id, sha256, path, bytes, media_type, kind, run_id, created_at)
      VALUES (@id, @sha256, @path, @bytes, @media_type, @kind, @run_id, @created_at)`),
    selectArtifact: db.prepare(`SELECT * FROM artifacts WHERE id = ?`),
    selectArtifactBySha: db.prepare(`SELECT * FROM artifacts WHERE sha256 = ?`),
  };
}

export { ValidationError };

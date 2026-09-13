/**
 * Versioned, idempotent SQLite migrations for the Periscope system of record.
 *
 * Rules:
 *  - Migrations are append-only. Never edit an applied migration; add a new one.
 *  - Every migration is applied inside its own transaction and recorded in
 *    `schema_migrations`. Re-running is a no-op.
 *  - The database is never deleted or recreated implicitly.
 *
 * Money is stored as integer micro-dollars (1 USD = 1_000_000). Floating point
 * dollars are converted exactly once, at the write boundary, and never summed
 * as floats.
 *
 * Timestamps are UTC ISO-8601 strings with a trailing `Z`.
 */

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "initial_system_of_record",
    sql: /* sql */ `
      ------------------------------------------------------------------
      -- runs
      ------------------------------------------------------------------
      CREATE TABLE runs (
        id                TEXT PRIMARY KEY,
        status            TEXT NOT NULL DEFAULT 'queued',
        goal              TEXT,
        category          TEXT,
        cap_micro_usd     INTEGER NOT NULL DEFAULT 0,
        spent_micro_usd   INTEGER NOT NULL DEFAULT 0,
        created_at        TEXT NOT NULL,
        updated_at        TEXT NOT NULL,
        completed_at      TEXT,
        payload           TEXT NOT NULL,
        CHECK (cap_micro_usd   >= 0),
        CHECK (spent_micro_usd >= 0)
      );
      CREATE INDEX runs_status_idx     ON runs (status);
      CREATE INDEX runs_created_at_idx ON runs (created_at);

      ------------------------------------------------------------------
      -- jobs
      ------------------------------------------------------------------
      CREATE TABLE jobs (
        id           TEXT PRIMARY KEY,
        run_id       TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
        purpose      TEXT NOT NULL,
        competitor   TEXT,
        url          TEXT,
        state        TEXT NOT NULL DEFAULT 'queued',
        reason       TEXT,
        created_at   TEXT NOT NULL,
        updated_at   TEXT NOT NULL,
        payload      TEXT NOT NULL,
        CHECK (purpose IN ('surface','reveal','borders','walker','setup')),
        CHECK (state IN ('queued','starting','running','awaiting_human',
                         'finalizing','completed','partial','failed','cancelled'))
      );
      CREATE INDEX jobs_run_state_idx  ON jobs (run_id, state);
      CREATE INDEX jobs_run_comp_idx   ON jobs (run_id, competitor);
      CREATE INDEX jobs_updated_at_idx ON jobs (updated_at);

      ------------------------------------------------------------------
      -- leases (one Steel session lease; Person C writes these via storage)
      ------------------------------------------------------------------
      CREATE TABLE leases (
        id                    TEXT PRIMARY KEY,
        run_id                TEXT REFERENCES runs (id) ON DELETE CASCADE,
        job_id                TEXT REFERENCES jobs (id) ON DELETE CASCADE,
        session_id            TEXT,
        purpose               TEXT NOT NULL,
        vantage_country       TEXT,
        vantage_region        TEXT,
        vantage_device        TEXT,
        vantage_authenticated INTEGER,
        profile_id            TEXT,
        account_ref           TEXT,
        viewer_url            TEXT,
        acquired_at           TEXT NOT NULL,
        deadline_at           TEXT,
        released_at           TEXT,
        payload               TEXT NOT NULL,
        CHECK (purpose IN ('surface','reveal','borders','walker','setup')),
        CHECK (vantage_device IS NULL OR vantage_device IN ('desktop','mobile'))
      );
      CREATE INDEX leases_run_idx     ON leases (run_id, acquired_at);
      CREATE INDEX leases_job_idx     ON leases (job_id);
      CREATE INDEX leases_session_idx ON leases (session_id);

      ------------------------------------------------------------------
      -- events: ordered, monotonic, the SSE replay log
      ------------------------------------------------------------------
      CREATE TABLE events (
        event_id       INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id         TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
        job_id         TEXT REFERENCES jobs (id) ON DELETE CASCADE,
        type           TEXT NOT NULL,
        observation_id TEXT REFERENCES observations (id) ON DELETE CASCADE,
        created_at     TEXT NOT NULL,
        payload        TEXT NOT NULL,
        CHECK (type IN ('observation','receipt','counter','handoff',
                        'job_state','spend','run_done'))
      );
      CREATE INDEX events_run_idx      ON events (run_id, event_id);
      CREATE INDEX events_job_idx      ON events (job_id, event_id);
      CREATE INDEX events_run_type_idx ON events (run_id, type, event_id);

      ------------------------------------------------------------------
      -- observations: ids are the deterministic ids from the shared contract
      ------------------------------------------------------------------
      CREATE TABLE observations (
        id                    TEXT PRIMARY KEY,
        run_id                TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
        job_id                TEXT NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
        competitor            TEXT NOT NULL,
        url                   TEXT NOT NULL,
        layer                 TEXT NOT NULL,
        source                TEXT NOT NULL,
        kind                  TEXT NOT NULL,
        text                  TEXT NOT NULL,
        perception            TEXT NOT NULL,
        missed_by_fetch       INTEGER,
        revealed_by_action    TEXT,
        revealed_by_label     TEXT,
        vantage_country       TEXT,
        vantage_region        TEXT,
        vantage_device        TEXT NOT NULL,
        vantage_authenticated INTEGER NOT NULL,
        screenshot_path       TEXT,
        steel_session_id      TEXT,
        viewer_url            TEXT,
        trace_start           TEXT,
        trace_end             TEXT,
        captured_at           TEXT NOT NULL,
        created_at            TEXT NOT NULL,
        payload               TEXT NOT NULL,
        CHECK (layer  IN ('surface','hidden','borders','interior')),
        CHECK (source IN ('steel_scrape','browser','benchmark_fetch')),
        CHECK (kind   IN ('text','option','price','document','image_text',
                          'tooltip','screen','link')),
        CHECK (perception IN ('dom','a11y','screenshot')),
        CHECK (vantage_device IN ('desktop','mobile')),
        CHECK (vantage_authenticated IN (0,1)),
        CHECK (missed_by_fetch IS NULL OR missed_by_fetch IN (0,1)),
        CHECK (revealed_by_action IS NULL OR revealed_by_action IN
               ('click','hover','select','toggle','scroll','login','none'))
      );
      CREATE INDEX obs_run_comp_idx    ON observations (run_id, competitor);
      CREATE INDEX obs_run_layer_idx   ON observations (run_id, layer);
      CREATE INDEX obs_run_source_idx  ON observations (run_id, source);
      CREATE INDEX obs_run_url_idx     ON observations (run_id, url);
      CREATE INDEX obs_run_kind_idx    ON observations (run_id, kind);
      CREATE INDEX obs_job_idx         ON observations (job_id);
      CREATE INDEX obs_captured_at_idx ON observations (run_id, captured_at);
      CREATE INDEX obs_missed_idx      ON observations (run_id, url, missed_by_fetch);
      CREATE INDEX obs_vantage_idx     ON observations
        (run_id, vantage_country, vantage_device, vantage_authenticated);

      ------------------------------------------------------------------
      -- receipts: per-action token/cost metering. Money in micro-dollars.
      ------------------------------------------------------------------
      CREATE TABLE receipts (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id     TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
        job_id     TEXT NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
        step       INTEGER NOT NULL,
        action     TEXT NOT NULL,
        target     TEXT,
        before     TEXT NOT NULL,
        after      TEXT NOT NULL,
        ok         INTEGER NOT NULL,
        tokens_in  INTEGER NOT NULL,
        tokens_out INTEGER NOT NULL,
        micro_usd  INTEGER NOT NULL,
        event_id   INTEGER REFERENCES events (event_id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        payload    TEXT NOT NULL,
        UNIQUE (job_id, step),
        CHECK (ok IN (0,1)),
        CHECK (micro_usd >= 0),
        CHECK (tokens_in >= 0),
        CHECK (tokens_out >= 0)
      );
      CREATE INDEX receipts_run_idx ON receipts (run_id, created_at);
      CREATE INDEX receipts_job_idx ON receipts (job_id, step);

      ------------------------------------------------------------------
      -- spend: reported cumulative spend snapshots (authoritative total is
      -- SUM(receipts.micro_usd); these rows are the emitted reports)
      ------------------------------------------------------------------
      CREATE TABLE spend (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id         TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
        micro_usd      INTEGER NOT NULL,
        cap_micro_usd  INTEGER NOT NULL,
        event_id       INTEGER REFERENCES events (event_id) ON DELETE CASCADE,
        created_at     TEXT NOT NULL,
        payload        TEXT NOT NULL,
        CHECK (micro_usd >= 0),
        CHECK (cap_micro_usd >= 0)
      );
      CREATE INDEX spend_run_idx ON spend (run_id, created_at);

      ------------------------------------------------------------------
      -- candidates: proposed, not yet evidence-checked
      ------------------------------------------------------------------
      CREATE TABLE candidates (
        id              TEXT PRIMARY KEY,
        run_id          TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
        competitor      TEXT NOT NULL,
        kind            TEXT NOT NULL,
        value           TEXT,
        status          TEXT NOT NULL DEFAULT 'proposed',
        observation_ids TEXT NOT NULL DEFAULT '[]',
        created_at      TEXT NOT NULL,
        payload         TEXT NOT NULL,
        CHECK (status IN ('proposed','accepted','rejected'))
      );
      CREATE INDEX candidates_run_idx ON candidates (run_id, competitor, kind);

      ------------------------------------------------------------------
      -- findings: every row carries evidence. Rows without evidence are
      -- rejected by the CHECK below (architecture 8.2 / test A10).
      ------------------------------------------------------------------
      CREATE TABLE findings (
        id              TEXT PRIMARY KEY,
        run_id          TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
        competitor      TEXT NOT NULL,
        kind            TEXT NOT NULL,
        title           TEXT,
        status          TEXT NOT NULL DEFAULT 'observed',
        value           TEXT,
        observation_ids TEXT NOT NULL,
        created_at      TEXT NOT NULL,
        payload         TEXT NOT NULL,
        CHECK (json_valid (observation_ids)),
        CHECK (json_array_length (observation_ids) > 0),
        CHECK (status IN ('observed','verified_working','rejected'))
      );
      CREATE INDEX findings_run_idx  ON findings (run_id, competitor, kind);
      CREATE INDEX findings_kind_idx ON findings (run_id, kind);

      -- referential integrity for evidence links
      CREATE TABLE finding_observations (
        finding_id     TEXT NOT NULL REFERENCES findings (id) ON DELETE CASCADE,
        observation_id TEXT NOT NULL REFERENCES observations (id) ON DELETE RESTRICT,
        PRIMARY KEY (finding_id, observation_id)
      );
      CREATE INDEX finding_obs_obs_idx ON finding_observations (observation_id);

      ------------------------------------------------------------------
      -- snapshots
      ------------------------------------------------------------------
      CREATE TABLE snapshots (
        id                    TEXT PRIMARY KEY,
        run_id                TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
        competitor            TEXT NOT NULL,
        taken_at              TEXT NOT NULL,
        vantage_country       TEXT,
        vantage_device        TEXT,
        vantage_authenticated INTEGER,
        observation_count     INTEGER NOT NULL DEFAULT 0,
        created_at            TEXT NOT NULL,
        payload               TEXT NOT NULL,
        UNIQUE (run_id, competitor, taken_at),
        CHECK (vantage_device IS NULL OR vantage_device IN ('desktop','mobile'))
      );
      CREATE INDEX snapshots_run_idx ON snapshots (run_id, competitor, taken_at);

      ------------------------------------------------------------------
      -- artifacts: content-addressed blobs on disk
      ------------------------------------------------------------------
      CREATE TABLE artifacts (
        id         TEXT PRIMARY KEY,
        sha256     TEXT NOT NULL UNIQUE,
        path       TEXT NOT NULL,
        bytes      INTEGER NOT NULL,
        media_type TEXT,
        kind       TEXT,
        run_id     TEXT REFERENCES runs (id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        CHECK (bytes >= 0)
      );
      CREATE INDEX artifacts_run_idx  ON artifacts (run_id, created_at);
      CREATE INDEX artifacts_kind_idx ON artifacts (kind);

      ------------------------------------------------------------------
      -- embedding_outbox: one row per observation, consumed by corpus.ts.
      -- UNIQUE(observation_id) is what makes a duplicate observation write
      -- add no second outbox entry.
      ------------------------------------------------------------------
      CREATE TABLE embedding_outbox (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        observation_id TEXT NOT NULL UNIQUE REFERENCES observations (id) ON DELETE CASCADE,
        run_id         TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
        status         TEXT NOT NULL DEFAULT 'pending',
        attempts       INTEGER NOT NULL DEFAULT 0,
        last_error     TEXT,
        created_at     TEXT NOT NULL,
        updated_at     TEXT NOT NULL,
        CHECK (status IN ('pending','done','failed'))
      );
      CREATE INDEX outbox_status_idx ON embedding_outbox (status, id);
      CREATE INDEX outbox_run_idx    ON embedding_outbox (run_id, status);
    `,
  },
  {
    version: 2,
    name: "benchmarks_job_kind_and_idempotency",
    sql: /* sql */ `
      ------------------------------------------------------------------
      -- jobs.kind: an Ayan-owned classification, additive and nullable.
      --
      -- The frozen contract's LeaseRequest.purpose describes what a Steel
      -- session is for. A benchmark fetch uses no Steel session at all, so it
      -- cannot be identified by purpose. "kind" names what the job IS, which is
      -- what coverage needs in order to find a benchmark execution without
      -- guessing from the URL.
      --
      -- SQLite cannot attach a CHECK via ALTER TABLE, so the allowed values are
      -- enforced in storage.ts (JOB_KINDS).
      ------------------------------------------------------------------
      ALTER TABLE jobs ADD COLUMN kind TEXT;
      CREATE INDEX jobs_kind_idx ON jobs (run_id, kind);

      -- Reason for a partial / failed / cancelled run.
      ALTER TABLE runs ADD COLUMN reason TEXT;

      ------------------------------------------------------------------
      -- benchmarks: one row per benchmark execution against one normalized
      -- URL from one vantage. Status is DERIVED from the owning job's final
      -- state plus captured_at; this table records identity and evidence, not
      -- a second opinion about success.
      --
      -- "stale" is an explicit marker (Person B's benchmark.ts sets it when a
      -- fetch tool served an index copy rather than a live fetch). It is never
      -- inferred from emptiness.
      ------------------------------------------------------------------
      CREATE TABLE benchmarks (
        id                    TEXT PRIMARY KEY,
        run_id                TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
        job_id                TEXT NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
        competitor            TEXT NOT NULL,
        url                   TEXT NOT NULL,
        url_normalized        TEXT NOT NULL,
        tool                  TEXT,
        vantage_country       TEXT,
        vantage_region        TEXT,
        vantage_device        TEXT NOT NULL,
        vantage_authenticated INTEGER NOT NULL,
        captured_at           TEXT,
        stale                 INTEGER NOT NULL DEFAULT 0,
        created_at            TEXT NOT NULL,
        updated_at            TEXT NOT NULL,
        payload               TEXT NOT NULL,
        UNIQUE (run_id, competitor, url_normalized,
                vantage_country, vantage_region, vantage_device, vantage_authenticated),
        CHECK (vantage_device IN ('desktop','mobile')),
        CHECK (vantage_authenticated IN (0,1)),
        CHECK (stale IN (0,1))
      );
      CREATE INDEX benchmarks_run_idx ON benchmarks (run_id, competitor, url_normalized);
      CREATE INDEX benchmarks_job_idx ON benchmarks (job_id);

      ------------------------------------------------------------------
      -- run_idempotency: POST /runs replay protection. The request hash makes
      -- reuse of one key with a different body a conflict rather than a
      -- silently wrong result.
      ------------------------------------------------------------------
      CREATE TABLE run_idempotency (
        key          TEXT PRIMARY KEY,
        run_id       TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
        request_hash TEXT NOT NULL,
        created_at   TEXT NOT NULL
      );
      CREATE INDEX run_idempotency_run_idx ON run_idempotency (run_id);
    `,
  },
];

MIGRATIONS.push({ version: 3, name: "observation_artifacts", sql: `
  CREATE TABLE observation_artifacts (
    observation_id TEXT NOT NULL REFERENCES observations(id) ON DELETE CASCADE,
    artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
    PRIMARY KEY (observation_id, artifact_id)
  );
` });

export const LATEST_VERSION: number =
  MIGRATIONS.reduce((max, m) => (m.version > max ? m.version : max), 0);

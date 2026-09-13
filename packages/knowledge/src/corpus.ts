/**
 * corpus.ts — the semantic index over the authoritative SQLite observations.
 *
 * Architecture 8.1:
 *   "Qdrant with MiniLM: one point per observation with the payload.
 *    Semantic search only. Rebuildable from SQLite."
 *
 * Consequences, enforced here:
 *   - Qdrant holds NO authoritative data. Search returns observation ids and
 *     scores; full evidence is hydrated from SQLite by the caller (or by
 *     `searchHydrated`).
 *   - Point ids are derived deterministically from observation ids, so
 *     re-indexing upserts instead of growing the collection.
 *   - Claude/Opus is never involved: embeddings are local MiniLM.
 *   - Embedding and Qdrant calls NEVER happen inside a SQLite transaction.
 *     Outbox rows are read, then embedded, then marked, as separate steps.
 */

import { createHash } from "node:crypto";

import type { Device, Layer, Observation, Source } from "@periscope/contracts";

import type { Storage } from "./storage.js";

/* ------------------------------------------------------------------ *
 * Configuration
 * ------------------------------------------------------------------ */

export interface CorpusConfig {
  qdrantUrl: string;
  qdrantApiKey?: string;
  collection: string;
  modelName: string;
  modelCacheDir?: string;
  vectorSize: number;
  batchSize: number;
}

export const DEFAULT_CORPUS_CONFIG: CorpusConfig = {
  qdrantUrl: "http://127.0.0.1:6333",
  collection: "periscope_observations",
  modelName: "Xenova/all-MiniLM-L6-v2",
  vectorSize: 384,
  batchSize: 64,
};

/** Read configuration from the environment, falling back to dev defaults. */
export function corpusConfigFromEnv(env: NodeJS.ProcessEnv = process.env): CorpusConfig {
  const vectorSize = Number(env["PERISCOPE_VECTOR_SIZE"] ?? DEFAULT_CORPUS_CONFIG.vectorSize);
  const batchSize = Number(env["PERISCOPE_EMBED_BATCH"] ?? DEFAULT_CORPUS_CONFIG.batchSize);
  const apiKey = env["QDRANT_API_KEY"];
  const cacheDir = env["PERISCOPE_MODEL_CACHE"];
  return {
    qdrantUrl: env["QDRANT_URL"] ?? DEFAULT_CORPUS_CONFIG.qdrantUrl,
    collection: env["QDRANT_COLLECTION"] ?? DEFAULT_CORPUS_CONFIG.collection,
    modelName: env["PERISCOPE_EMBED_MODEL"] ?? DEFAULT_CORPUS_CONFIG.modelName,
    vectorSize: Number.isFinite(vectorSize) ? vectorSize : DEFAULT_CORPUS_CONFIG.vectorSize,
    batchSize: Number.isFinite(batchSize) && batchSize > 0 ? batchSize : DEFAULT_CORPUS_CONFIG.batchSize,
    ...(apiKey === undefined ? {} : { qdrantApiKey: apiKey }),
    ...(cacheDir === undefined ? {} : { modelCacheDir: cacheDir }),
  };
}

/* ------------------------------------------------------------------ *
 * Ports — so tests can substitute without touching the network
 * ------------------------------------------------------------------ */

export interface Embedder {
  readonly dimension: number;
  /** Returns one L2-normalised vector per input string, in order. */
  embed(texts: readonly string[]): Promise<number[][]>;
}

/** The payload stored alongside each Qdrant point. Filter metadata only. */
export interface CorpusPayload {
  observationId: string;
  runId: string;
  jobId: string;
  competitor: string;
  url: string;
  layer: Layer;
  source: Source;
  kind: Observation["kind"];
  perception: Observation["perception"];
  country: string | null;
  region: string | null;
  device: Device;
  authenticated: boolean;
  missedByFetch: boolean | null;
  capturedAt: string;
  /** Verbatim normalised text; a convenience for debugging, never authoritative. */
  text: string;
}

export interface CorpusPoint {
  id: string;
  vector: number[];
  payload: CorpusPayload;
}

export interface CorpusFilter {
  runId?: string;
  competitor?: string | readonly string[];
  url?: string;
  layer?: Layer | readonly Layer[];
  source?: Source | readonly Source[];
  kind?: Observation["kind"] | readonly Observation["kind"][];
  perception?: Observation["perception"];
  country?: string | null;
  region?: string | null;
  device?: Device;
  authenticated?: boolean;
  missedByFetch?: boolean;
  capturedAfter?: string;
  capturedBefore?: string;
}

export interface SearchHit {
  observationId: string;
  score: number;
  payload: CorpusPayload;
}

export interface HydratedHit extends SearchHit {
  observation: Observation;
}

/** The minimal slice of a vector database this module needs. */
export interface VectorStore {
  ensureCollection(vectorSize: number): Promise<void>;
  dropCollection(): Promise<void>;
  upsert(points: readonly CorpusPoint[]): Promise<void>;
  search(vector: readonly number[], limit: number, filter?: CorpusFilter): Promise<SearchHit[]>;
  count(): Promise<number>;
  collectionExists(): Promise<boolean>;
}

/* ------------------------------------------------------------------ *
 * Point ids
 * ------------------------------------------------------------------ */

/**
 * Qdrant accepts an unsigned integer or a UUID as a point id. Observation ids
 * are sha256 hex, so we fold them into a deterministic RFC-4122 UUID (version
 * 5 nibble, RFC variant bits). Same observation id, same point id, forever —
 * which is what makes re-indexing an upsert rather than a duplicate.
 */
export function observationIdToPointId(observationId: string): string {
  const digest = createHash("sha256").update(observationId).digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x50; // version 5
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80; // RFC 4122 variant
  const hex = bytes.toString("hex");
  return (
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-` +
    `${hex.slice(16, 20)}-${hex.slice(20, 32)}`
  );
}

/** The text we embed for an observation. Kept in one place so A5 is stable. */
export function embeddingTextFor(observation: Observation): string {
  return observation.text;
}

export function payloadFor(observation: Observation): CorpusPayload {
  return {
    observationId: observation.id,
    runId: observation.runId,
    jobId: observation.jobId,
    competitor: observation.competitor,
    url: observation.url,
    layer: observation.layer,
    source: observation.source,
    kind: observation.kind,
    perception: observation.perception,
    country: observation.vantage.country,
    region: observation.vantage.region ?? null,
    device: observation.vantage.device,
    authenticated: observation.vantage.authenticated,
    missedByFetch: observation.missedByFetch ?? null,
    capturedAt: observation.capturedAt,
    text: observation.text,
  };
}

/* ------------------------------------------------------------------ *
 * Corpus
 * ------------------------------------------------------------------ */

export interface CorpusDeps {
  storage: Storage;
  embedder: Embedder;
  vectors: VectorStore;
  config?: Partial<CorpusConfig>;
}

export interface IndexOutcome {
  indexed: number;
  failed: number;
  errors: { observationId: string; error: string }[];
}

export class Corpus {
  readonly #storage: Storage;
  readonly #embedder: Embedder;
  readonly #vectors: VectorStore;
  readonly #config: CorpusConfig;

  constructor(deps: CorpusDeps) {
    this.#storage = deps.storage;
    this.#embedder = deps.embedder;
    this.#vectors = deps.vectors;
    this.#config = { ...DEFAULT_CORPUS_CONFIG, ...deps.config };

    if (this.#embedder.dimension !== this.#config.vectorSize) {
      throw new Error(
        `embedder dimension ${this.#embedder.dimension} does not match configured ` +
          `vectorSize ${this.#config.vectorSize}`,
      );
    }
  }

  get config(): CorpusConfig {
    return this.#config;
  }

  ensureCollection(): Promise<void> {
    return this.#vectors.ensureCollection(this.#config.vectorSize);
  }

  dropCollection(): Promise<void> {
    return this.#vectors.dropCollection();
  }

  count(): Promise<number> {
    return this.#vectors.count();
  }

  /** Embed and upsert a batch of observations. No SQLite transaction is open. */
  async indexObservations(observations: readonly Observation[]): Promise<number> {
    if (observations.length === 0) return 0;
    let total = 0;
    for (let i = 0; i < observations.length; i += this.#config.batchSize) {
      const batch = observations.slice(i, i + this.#config.batchSize);
      const vectors = await this.#embedder.embed(batch.map(embeddingTextFor));
      if (vectors.length !== batch.length) {
        throw new Error(`embedder returned ${vectors.length} vectors for ${batch.length} inputs`);
      }
      const points: CorpusPoint[] = batch.map((observation, index) => {
        const vector = vectors[index];
        if (!vector) throw new Error(`missing vector for observation ${observation.id}`);
        if (vector.length !== this.#config.vectorSize) {
          throw new Error(
            `vector for ${observation.id} has ${vector.length} dimensions, expected ${this.#config.vectorSize}`,
          );
        }
        return {
          id: observationIdToPointId(observation.id),
          vector,
          payload: payloadFor(observation),
        };
      });
      await this.#vectors.upsert(points);
      total += points.length;
    }
    return total;
  }

  /**
   * Drain pending embedding-outbox work.
   *
   * Order matters: read outbox (short read), embed + upsert OUTSIDE any
   * transaction, then mark rows. A crash between steps leaves rows pending,
   * which is safe — the outbox is re-drivable and SQLite still has everything.
   */
  async indexPending(limit = 512): Promise<IndexOutcome> {
    const outcome: IndexOutcome = { indexed: 0, failed: 0, errors: [] };
    let remaining = limit;

    while (remaining > 0) {
      const take = Math.min(this.#config.batchSize, remaining);
      const pending = this.#storage.pendingEmbeddings(take);
      if (pending.length === 0) break;

      try {
        await this.indexObservations(pending.map((entry) => entry.observation));
        this.#storage.markEmbedded(pending.map((entry) => entry.observationId));
        outcome.indexed += pending.length;
      } catch (cause) {
        const message = (cause as Error).message;
        for (const entry of pending) {
          this.#storage.markEmbeddingFailed(entry.observationId, message);
          outcome.errors.push({ observationId: entry.observationId, error: message });
        }
        outcome.failed += pending.length;
        break; // a failing backend will keep failing; stop and report
      }

      remaining -= pending.length;
      if (pending.length < take) break;
    }

    return outcome;
  }

  /** Semantic search. Returns observation ids and scores — not evidence. */
  async search(query: string, options: { limit?: number; filter?: CorpusFilter } = {}): Promise<SearchHit[]> {
    const limit = options.limit ?? 10;
    const [vector] = await this.#embedder.embed([query]);
    if (!vector) throw new Error("embedder returned no vector for the query");
    return this.#vectors.search(vector, limit, options.filter);
  }

  /** Search, then hydrate full evidence from SQLite (the source of truth). */
  async searchHydrated(
    query: string,
    options: { limit?: number; filter?: CorpusFilter } = {},
  ): Promise<HydratedHit[]> {
    const hits = await this.search(query, options);
    const hydrated: HydratedHit[] = [];
    for (const hit of hits) {
      const observation = this.#storage.getObservation(hit.observationId);
      if (!observation) continue; // vector index is stale; SQLite wins
      hydrated.push({ ...hit, observation });
    }
    return hydrated;
  }

  /**
   * Rebuild the whole collection from SQLite: drop, recreate, re-embed.
   * This is the A4 guarantee — Qdrant is disposable.
   */
  async rebuild(runId?: string): Promise<{ points: number; observationIds: string[] }> {
    await this.#vectors.dropCollection();
    await this.#vectors.ensureCollection(this.#config.vectorSize);

    const observationIds: string[] = [];
    let batch: Observation[] = [];
    let points = 0;

    for (const observation of this.#storage.iterateObservations(runId)) {
      observationIds.push(observation.id);
      batch.push(observation);
      if (batch.length >= this.#config.batchSize) {
        points += await this.indexObservations(batch);
        batch = [];
      }
    }
    if (batch.length > 0) points += await this.indexObservations(batch);

    this.#storage.resetEmbeddingOutbox(runId);
    this.#storage.markEmbedded(observationIds);

    return { points, observationIds };
  }
}

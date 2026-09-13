/**
 * Qdrant REST adapter implementing the `VectorStore` port.
 *
 * Qdrant stores no authoritative data: points carry filter metadata and the
 * observation id, and evidence is always hydrated from SQLite afterwards.
 */

import { QdrantClient } from "@qdrant/js-client-rest";

import type {
  CorpusFilter,
  CorpusPayload,
  CorpusPoint,
  SearchHit,
  VectorStore,
} from "./corpus.js";

export interface QdrantStoreOptions {
  url: string;
  collection: string;
  apiKey?: string;
  /** Wait for indexing to complete on write. Default true (tests need it). */
  waitForUpsert?: boolean;
}

type QdrantCondition =
  | { key: string; match: { value: string | number | boolean } }
  | { key: string; match: { any: (string | number)[] } }
  | { key: string; range: { gte?: string; lte?: string } }
  | { key: string; is_null: { key: string } };

export class QdrantVectorStore implements VectorStore {
  readonly #client: QdrantClient;
  readonly #collection: string;
  readonly #wait: boolean;

  constructor(options: QdrantStoreOptions) {
    this.#client = new QdrantClient({
      url: options.url,
      ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
    });
    this.#collection = options.collection;
    this.#wait = options.waitForUpsert ?? true;
  }

  get collection(): string {
    return this.#collection;
  }

  async collectionExists(): Promise<boolean> {
    const result = await this.#client.collectionExists(this.#collection);
    return result.exists;
  }

  async ensureCollection(vectorSize: number): Promise<void> {
    if (await this.collectionExists()) return;
    await this.#client.createCollection(this.#collection, {
      vectors: { size: vectorSize, distance: "Cosine" },
    });
    // Indexes that make the architecture's filters cheap.
    for (const field of [
      "runId", "competitor", "url", "layer", "source", "kind",
      "perception", "country", "region", "device",
    ]) {
      await this.#client.createPayloadIndex(this.#collection, {
        field_name: field,
        field_schema: "keyword",
        wait: true,
      });
    }
    for (const field of ["authenticated", "missedByFetch"]) {
      await this.#client.createPayloadIndex(this.#collection, {
        field_name: field,
        field_schema: "bool",
        wait: true,
      });
    }
  }

  async dropCollection(): Promise<void> {
    if (!(await this.collectionExists())) return;
    await this.#client.deleteCollection(this.#collection);
  }

  async upsert(points: readonly CorpusPoint[]): Promise<void> {
    if (points.length === 0) return;
    await this.#client.upsert(this.#collection, {
      wait: this.#wait,
      points: points.map((point) => ({
        id: point.id,
        vector: point.vector,
        payload: point.payload as unknown as Record<string, unknown>,
      })),
    });
  }

  async count(): Promise<number> {
    if (!(await this.collectionExists())) return 0;
    const result = await this.#client.count(this.#collection, { exact: true });
    return result.count;
  }

  async search(
    vector: readonly number[],
    limit: number,
    filter?: CorpusFilter,
  ): Promise<SearchHit[]> {
    const qdrantFilter = buildQdrantFilter(filter);
    const response = await this.#client.query(this.#collection, {
      query: [...vector],
      limit,
      with_payload: true,
      ...(qdrantFilter === undefined ? {} : { filter: qdrantFilter }),
    });

    return response.points.map((point) => {
      const payload = point.payload as unknown as CorpusPayload;
      return {
        observationId: payload.observationId,
        score: point.score,
        payload,
      };
    });
  }
}

/** Translate a CorpusFilter into Qdrant's must/is_null filter shape. */
export function buildQdrantFilter(
  filter: CorpusFilter | undefined,
): { must: QdrantCondition[] } | undefined {
  if (!filter) return undefined;
  const must: QdrantCondition[] = [];

  const eq = (key: string, value: string | number | boolean): void => {
    must.push({ key, match: { value } });
  };
  const anyOf = (key: string, values: readonly string[]): void => {
    if (values.length === 1) eq(key, values[0] as string);
    else must.push({ key, match: { any: [...values] } });
  };

  if (filter.runId !== undefined) eq("runId", filter.runId);
  if (filter.url !== undefined) eq("url", filter.url);
  if (filter.perception !== undefined) eq("perception", filter.perception);
  if (filter.device !== undefined) eq("device", filter.device);
  if (filter.authenticated !== undefined) eq("authenticated", filter.authenticated);
  if (filter.missedByFetch !== undefined) eq("missedByFetch", filter.missedByFetch);

  if (filter.competitor !== undefined) {
    anyOf("competitor", typeof filter.competitor === "string" ? [filter.competitor] : filter.competitor);
  }
  if (filter.layer !== undefined) {
    anyOf("layer", typeof filter.layer === "string" ? [filter.layer] : filter.layer);
  }
  if (filter.source !== undefined) {
    anyOf("source", typeof filter.source === "string" ? [filter.source] : filter.source);
  }
  if (filter.kind !== undefined) {
    anyOf("kind", typeof filter.kind === "string" ? [filter.kind] : filter.kind);
  }

  if (filter.country !== undefined) {
    if (filter.country === null) must.push({ key: "country", is_null: { key: "country" } });
    else eq("country", filter.country);
  }
  if (filter.region !== undefined) {
    if (filter.region === null) must.push({ key: "region", is_null: { key: "region" } });
    else eq("region", filter.region);
  }

  if (filter.capturedAfter !== undefined || filter.capturedBefore !== undefined) {
    must.push({
      key: "capturedAt",
      range: {
        ...(filter.capturedAfter === undefined ? {} : { gte: filter.capturedAfter }),
        ...(filter.capturedBefore === undefined ? {} : { lte: filter.capturedBefore }),
      },
    });
  }

  return must.length > 0 ? { must } : undefined;
}

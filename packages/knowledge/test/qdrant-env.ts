/**
 * Shared Qdrant probe for A3 and A4.
 *
 * These tests run against a REAL Qdrant. If one is not reachable the suite
 * fails loudly with the exact command to start it — it never fakes a pass.
 * Set PERISCOPE_SKIP_QDRANT=1 to skip them deliberately (CI without Qdrant).
 */

import { QdrantVectorStore } from "../src/qdrant.js";
import { corpusConfigFromEnv } from "../src/corpus.js";

export const QDRANT_HELP =
  "Qdrant is not reachable. Start it with one of:\n" +
  "  docker compose up -d qdrant        (repo root, needs Docker)\n" +
  "  bash scripts/dev-qdrant.sh         (downloads and runs the native binary)\n" +
  "Then re-run. Override the URL with QDRANT_URL.";

export async function qdrantReachable(url: string, timeoutMs = 2_000): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${url}/readyz`, { signal: controller.signal });
      return response.ok;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}

export function testCollectionName(suffix: string): string {
  return `periscope_test_${suffix}_${process.pid}`;
}

export function makeStore(collection: string): QdrantVectorStore {
  const config = corpusConfigFromEnv();
  return new QdrantVectorStore({
    url: config.qdrantUrl,
    collection,
    ...(config.qdrantApiKey === undefined ? {} : { apiKey: config.qdrantApiKey }),
    waitForUpsert: true,
  });
}

export function qdrantUrl(): string {
  return corpusConfigFromEnv().qdrantUrl;
}

export const skipQdrant = process.env["PERISCOPE_SKIP_QDRANT"] === "1";

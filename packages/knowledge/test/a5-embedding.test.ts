/**
 * A5 — Embedding determinism.
 *
 * "Same text, same vector."
 *
 * Runs the REAL MiniLM model. The first run downloads it (~90 MB) into the
 * Transformers.js cache; later runs are offline. Set PERISCOPE_SKIP_MODEL=1 to
 * skip when there is no network.
 */

import { beforeAll, describe, expect, it } from "vitest";

import { MiniLmEmbedder, l2Norm } from "../src/embedder.js";
import { corpusConfigFromEnv } from "../src/corpus.js";

const skip = process.env["PERISCOPE_SKIP_MODEL"] === "1";
const EXPECTED_DIMENSION = 384;

/** Vectors are float32 under the hood; this is as tight as is meaningful. */
const TOLERANCE = 1e-6;

describe.skipIf(skip)("A5 — embedding determinism", () => {
  let embedder: MiniLmEmbedder;

  beforeAll(async () => {
    const config = corpusConfigFromEnv();
    embedder = new MiniLmEmbedder({
      modelName: config.modelName,
      dimension: config.vectorSize,
      ...(config.modelCacheDir === undefined ? {} : { cacheDir: config.modelCacheDir }),
    });
    await embedder.warmup();
  }, 600_000);

  it("produces the configured dimension", async () => {
    const [vector] = await embedder.embed(["Service Level Agreement"]);
    expect(vector).toBeDefined();
    expect(vector).toHaveLength(EXPECTED_DIMENSION);
    expect(embedder.dimension).toBe(EXPECTED_DIMENSION);
  });

  it("returns identical vectors for identical normalized text", async () => {
    const text = "Annual billing saves 20% on the Business plan";

    const [first] = await embedder.embed([text]);
    const [second] = await embedder.embed([text]);
    expect(first).toBeDefined();
    expect(second).toBeDefined();

    const a = first as number[];
    const b = second as number[];
    expect(a.length).toBe(b.length);
    expect(a.length).toBe(EXPECTED_DIMENSION);

    for (let i = 0; i < a.length; i += 1) {
      expect(Math.abs((a[i] as number) - (b[i] as number))).toBeLessThanOrEqual(TOLERANCE);
    }
  });

  it("is stable across batch shapes and positions", async () => {
    const text = "Service Level Agreement";
    const [alone] = await embedder.embed([text]);
    const batch = await embedder.embed(["unrelated filler", text, "more filler"]);
    const inBatch = batch[1];

    expect(alone).toBeDefined();
    expect(inBatch).toBeDefined();
    const a = alone as number[];
    const b = inBatch as number[];

    for (let i = 0; i < a.length; i += 1) {
      expect(Math.abs((a[i] as number) - (b[i] as number))).toBeLessThanOrEqual(1e-5);
    }
  });

  it("returns L2-normalised vectors so cosine distance is exact", async () => {
    const vectors = await embedder.embed([
      "Terms of Service",
      "Acceptable Use Policy",
      "a much longer piece of text that should still normalise to the unit sphere",
    ]);
    expect(vectors).toHaveLength(3);
    for (const vector of vectors) {
      expect(vector).toHaveLength(EXPECTED_DIMENSION);
      expect(Math.abs(l2Norm(vector) - 1)).toBeLessThan(1e-5);
    }
  });

  it("distinguishes different text", async () => {
    const [a, b] = await embedder.embed([
      "Service Level Agreement",
      "Nintendo Switch release date",
    ]);
    expect(a).toBeDefined();
    expect(b).toBeDefined();

    let dot = 0;
    const x = a as number[];
    const y = b as number[];
    for (let i = 0; i < x.length; i += 1) dot += (x[i] as number) * (y[i] as number);

    // Unrelated sentences must not be near-identical.
    expect(dot).toBeLessThan(0.9);
  });

  it("returns an empty array for no input", async () => {
    expect(await embedder.embed([])).toEqual([]);
  });
});

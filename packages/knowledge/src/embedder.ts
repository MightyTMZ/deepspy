/**
 * MiniLM sentence embeddings via Transformers.js, running locally in Node.
 *
 * No Claude/Opus involvement: this is a local ONNX model. Mean pooling plus L2
 * normalisation gives unit vectors, so Qdrant's cosine distance is exact.
 *
 * The model is lazily loaded on first use and cached in memory; on disk it is
 * cached under `modelCacheDir` (or Transformers.js's default).
 */

import type { Embedder } from "./corpus.js";

export interface MiniLmOptions {
  modelName?: string;
  dimension?: number;
  cacheDir?: string;
  /** Force a fresh pipeline rather than the process-wide cached one. */
  isolated?: boolean;
}

type FeatureExtractionPipeline = (
  texts: string[],
  options: { pooling: "mean"; normalize: boolean },
) => Promise<{ dims: number[]; data: Float32Array | number[] }>;

const pipelineCache = new Map<string, Promise<FeatureExtractionPipeline>>();

async function loadPipeline(
  modelName: string,
  cacheDir: string | undefined,
  isolated: boolean,
): Promise<FeatureExtractionPipeline> {
  const key = `${modelName}::${cacheDir ?? ""}`;
  if (!isolated) {
    const cached = pipelineCache.get(key);
    if (cached) return cached;
  }

  const created = (async (): Promise<FeatureExtractionPipeline> => {
    const mod = await import("@huggingface/transformers");
    if (cacheDir !== undefined) {
      mod.env.cacheDir = cacheDir;
    }
    const pipe = await mod.pipeline("feature-extraction", modelName);
    return pipe as unknown as FeatureExtractionPipeline;
  })();

  if (!isolated) pipelineCache.set(key, created);
  return created;
}

export class MiniLmEmbedder implements Embedder {
  readonly dimension: number;
  readonly modelName: string;
  readonly #cacheDir: string | undefined;
  readonly #isolated: boolean;
  #pipeline: FeatureExtractionPipeline | undefined;

  constructor(options: MiniLmOptions = {}) {
    this.modelName = options.modelName ?? "Xenova/all-MiniLM-L6-v2";
    this.dimension = options.dimension ?? 384;
    this.#cacheDir = options.cacheDir;
    this.#isolated = options.isolated ?? false;
  }

  /** Load the model. Call once up front to keep it out of timed sections. */
  async warmup(): Promise<void> {
    await this.#ensure();
  }

  async embed(texts: readonly string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const pipe = await this.#ensure();
    const output = await pipe([...texts], { pooling: "mean", normalize: true });

    const flat = output.data instanceof Float32Array ? output.data : Float32Array.from(output.data);
    const dims = output.dims;
    const width = dims[dims.length - 1] ?? this.dimension;

    if (width !== this.dimension) {
      throw new Error(
        `model ${this.modelName} produced ${width}-dimensional vectors, expected ${this.dimension}`,
      );
    }
    if (flat.length !== texts.length * width) {
      throw new Error(
        `model ${this.modelName} produced ${flat.length} values for ${texts.length} inputs ` +
          `at width ${width}`,
      );
    }

    const vectors: number[][] = [];
    for (let i = 0; i < texts.length; i += 1) {
      vectors.push(Array.from(flat.subarray(i * width, (i + 1) * width)));
    }
    return vectors;
  }

  async #ensure(): Promise<FeatureExtractionPipeline> {
    if (!this.#pipeline) {
      this.#pipeline = await loadPipeline(this.modelName, this.#cacheDir, this.#isolated);
    }
    return this.#pipeline;
  }
}

/** L2 norm of a vector; used by tests to assert normalisation. */
export function l2Norm(vector: readonly number[]): number {
  let sum = 0;
  for (const value of vector) sum += value * value;
  return Math.sqrt(sum);
}

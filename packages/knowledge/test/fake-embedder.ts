/**
 * A deterministic stand-in for MiniLM.
 *
 * A3 and A4 test the vector-store contract — upsert identity, filters, point
 * counts, rebuild — not embedding quality. Using a hash-derived embedder keeps
 * those tests fast, offline, and reproducible. A5 exercises the real model.
 */

import { createHash } from "node:crypto";

import type { Embedder } from "../src/corpus.js";

export class DeterministicEmbedder implements Embedder {
  readonly dimension: number;

  constructor(dimension = 384) {
    this.dimension = dimension;
  }

  embed(texts: readonly string[]): Promise<number[][]> {
    return Promise.resolve(texts.map((text) => this.#vector(text)));
  }

  #vector(text: string): number[] {
    const values = new Float64Array(this.dimension);
    let counter = 0;
    let filled = 0;
    while (filled < this.dimension) {
      const digest = createHash("sha256").update(`${text}#${counter}`).digest();
      for (let i = 0; i + 4 <= digest.length && filled < this.dimension; i += 4) {
        // Map 4 bytes into [-1, 1).
        values[filled] = (digest.readUInt32BE(i) / 0xffff_ffff) * 2 - 1;
        filled += 1;
      }
      counter += 1;
    }

    let norm = 0;
    for (const v of values) norm += v * v;
    norm = Math.sqrt(norm) || 1;

    const out: number[] = new Array<number>(this.dimension);
    for (let i = 0; i < this.dimension; i += 1) out[i] = (values[i] as number) / norm;
    return out;
  }
}

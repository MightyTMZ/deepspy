/**
 * artifacts.ts — content-addressed blob storage.
 *
 * Architecture 8.1: "Artifacts: screenshots, raw responses, documents, traces.
 * Temp file, atomic rename, hashed path, referenced by id."
 *
 * This module stores and resolves bytes it is handed. It does NOT download
 * anything from Steel — that belongs to Person C's layer.
 *
 * It never opens SQLite. Metadata is persisted through the public Storage API.
 */

import { createHash } from "node:crypto";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  promises as fs,
} from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";

import type { ArtifactRecord, Storage } from "./storage.js";

export class ArtifactError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactError";
  }
}

export class ArtifactMissingError extends ArtifactError {
  readonly artifactId: string;
  constructor(artifactId: string, detail: string) {
    super(`artifact ${artifactId} is missing: ${detail}`);
    this.name = "ArtifactMissingError";
    this.artifactId = artifactId;
  }
}

export class ArtifactCorruptedError extends ArtifactError {
  readonly artifactId: string;
  readonly expectedSha256: string;
  readonly actualSha256: string;
  constructor(artifactId: string, expected: string, actual: string) {
    super(
      `artifact ${artifactId} is corrupted: expected sha256 ${expected}, found ${actual}`,
    );
    this.name = "ArtifactCorruptedError";
    this.artifactId = artifactId;
    this.expectedSha256 = expected;
    this.actualSha256 = actual;
  }
}

export interface ArtifactMeta {
  /** screenshot | raw_response | document | trace | ... */
  kind?: string;
  mediaType?: string;
  runId?: string;
}

export interface ArtifactRef {
  id: string;
  sha256: string;
  /** Path relative to the artifact root, as stored in SQLite. */
  path: string;
  /** Absolute path on disk. */
  absolutePath: string;
  bytes: number;
  /** False when identical content was already stored. */
  created: boolean;
}

export interface ArtifactStoreOptions {
  /** Root directory for the content-addressed tree. */
  root: string;
  storage: Storage;
}

/** sha256 hex of a buffer. */
export function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** sha256 hex of a file, streamed (does not load it into memory). */
export async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

/**
 * Storage path for a digest: `ab/cd/<digest>`.
 * Two levels of fan-out keeps directory sizes sane at hackathon volumes.
 */
export function artifactRelativePath(sha256: string): string {
  if (!/^[0-9a-f]{64}$/.test(sha256)) {
    throw new ArtifactError(`not a sha256 hex digest: ${sha256}`);
  }
  return join(sha256.slice(0, 2), sha256.slice(2, 4), sha256);
}

/** Artifact id is the digest itself: identical content is the same artifact. */
export function artifactIdFor(sha256: string): string {
  if (!/^[0-9a-f]{64}$/.test(sha256)) {
    throw new ArtifactError(`not a sha256 hex digest: ${sha256}`);
  }
  return sha256;
}

export class ArtifactStore {
  readonly #root: string;
  readonly #storage: Storage;

  constructor(options: ArtifactStoreOptions) {
    this.#root = resolve(options.root);
    this.#storage = options.storage;
    mkdirSync(this.#root, { recursive: true });
  }

  get root(): string {
    return this.#root;
  }

  /** Store bytes. Identical content is deduplicated and not rewritten. */
  async putBytes(bytes: Uint8Array, meta: ArtifactMeta = {}): Promise<ArtifactRef> {
    const sha256 = hashBytes(bytes);
    return this.#place(sha256, bytes.byteLength, meta, async (destination) => {
      const temporary = this.#temporaryPath(sha256);
      await fs.writeFile(temporary, bytes, { flag: "wx" });
      await this.#atomicRename(temporary, destination);
    });
  }

  /**
   * Store an existing temporary file. The source is consumed: on success it is
   * renamed into place (or removed when the content was already stored).
   */
  async putFile(temporaryPath: string, meta: ArtifactMeta = {}): Promise<ArtifactRef> {
    if (!existsSync(temporaryPath)) {
      throw new ArtifactError(`source file does not exist: ${temporaryPath}`);
    }
    const sha256 = await hashFile(temporaryPath);
    const stat = await fs.stat(temporaryPath);

    const ref = await this.#place(sha256, stat.size, meta, async (destination) => {
      await this.#atomicRename(temporaryPath, destination);
    });

    // Deduplicated: the source was never moved, so clean it up.
    if (!ref.created && existsSync(temporaryPath)) {
      await fs.rm(temporaryPath, { force: true });
    }
    return ref;
  }

  /** Absolute path for an artifact id. Throws if unknown or absent on disk. */
  async resolve(artifactId: string): Promise<string> {
    const record = this.#requireRecord(artifactId);
    const absolute = this.#absolute(record.path);
    try {
      await fs.access(absolute);
    } catch {
      throw new ArtifactMissingError(artifactId, `no file at ${absolute}`);
    }
    return absolute;
  }

  /** Read an artifact, verifying its content hash before returning it. */
  async read(artifactId: string): Promise<Buffer> {
    const record = this.#requireRecord(artifactId);
    const absolute = await this.resolve(artifactId);
    const bytes = await fs.readFile(absolute);
    const actual = hashBytes(bytes);
    if (actual !== record.sha256) {
      throw new ArtifactCorruptedError(artifactId, record.sha256, actual);
    }
    return bytes;
  }

  /** Re-hash on disk and compare. Throws on missing or corrupted content. */
  async verify(artifactId: string): Promise<true> {
    const record = this.#requireRecord(artifactId);
    const absolute = await this.resolve(artifactId);
    const actual = await hashFile(absolute);
    if (actual !== record.sha256) {
      throw new ArtifactCorruptedError(artifactId, record.sha256, actual);
    }
    return true;
  }

  /** Metadata only; no disk access. */
  stat(artifactId: string): ArtifactRecord | null {
    return this.#storage.getArtifact(artifactId);
  }

  /* ---------------- internals ---------------- */

  #requireRecord(artifactId: string): ArtifactRecord {
    const record = this.#storage.getArtifact(artifactId);
    if (!record) throw new ArtifactMissingError(artifactId, "no metadata row in storage");
    return record;
  }

  #absolute(relativePath: string): string {
    if (isAbsolute(relativePath)) {
      throw new ArtifactError(`artifact path must be relative, got ${relativePath}`);
    }
    const absolute = resolve(this.#root, relativePath);
    if (absolute !== this.#root && !absolute.startsWith(this.#root + sep)) {
      throw new ArtifactError(`artifact path escapes the root: ${relativePath}`);
    }
    return absolute;
  }

  #temporaryPath(sha256: string): string {
    const dir = join(this.#root, ".tmp");
    mkdirSync(dir, { recursive: true });
    const unique = `${sha256.slice(0, 12)}-${process.pid}-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 10)}`;
    return join(dir, `${unique}.part`);
  }

  async #atomicRename(from: string, to: string): Promise<void> {
    await fs.mkdir(dirname(to), { recursive: true });
    await fs.rename(from, to);
  }

  /**
   * Common path: dedupe, write through a temp file, atomic rename, then record
   * metadata through the public storage API.
   */
  async #place(
    sha256: string,
    bytes: number,
    meta: ArtifactMeta,
    write: (destination: string) => Promise<void>,
  ): Promise<ArtifactRef> {
    const id = artifactIdFor(sha256);
    const relativePath = artifactRelativePath(sha256);
    const absolutePath = this.#absolute(relativePath);

    const existing = this.#storage.getArtifactBySha256(sha256);
    const onDisk = existsSync(absolutePath);

    if (existing && onDisk) {
      return { id: existing.id, sha256, path: existing.path, absolutePath, bytes: existing.bytes, created: false };
    }

    if (!onDisk) {
      await write(absolutePath);
    }

    const record = this.#storage.recordArtifact({
      id,
      sha256,
      path: relativePath,
      bytes,
      ...(meta.mediaType === undefined ? {} : { mediaType: meta.mediaType }),
      ...(meta.kind === undefined ? {} : { kind: meta.kind }),
      ...(meta.runId === undefined ? {} : { runId: meta.runId }),
    });

    return {
      id: record.id,
      sha256,
      path: record.path,
      absolutePath,
      bytes: record.bytes,
      created: !onDisk,
    };
  }
}

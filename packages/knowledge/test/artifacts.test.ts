/**
 * Artifact storage: hashing, deduplication, atomic writes, resolution, and
 * clear failures for missing or corrupted content.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

import {
  ArtifactCorruptedError,
  ArtifactMissingError,
  ArtifactStore,
  artifactIdFor,
  artifactRelativePath,
  hashBytes,
} from "../src/artifacts.js";
import type { Storage } from "../src/storage.js";
import { seedRunAndJob, tempStorage } from "./helpers.js";

const SCREENSHOT = Buffer.from("fake png bytes for a pricing table");

describe("artifacts", () => {
  let storage: Storage;
  let dir: string;
  let cleanup: () => void;
  let store: ArtifactStore;

  beforeEach(() => {
    const t = tempStorage();
    storage = t.storage;
    dir = t.dir;
    cleanup = t.cleanup;
    store = new ArtifactStore({ root: join(dir, "artifacts"), storage });
  });

  afterEach(() => cleanup());

  it("derives a stable id and hashed path from content", () => {
    const sha256 = hashBytes(SCREENSHOT);
    expect(sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(artifactIdFor(sha256)).toBe(sha256);
    expect(artifactRelativePath(sha256)).toBe(
      join(sha256.slice(0, 2), sha256.slice(2, 4), sha256),
    );
    // Stable across calls.
    expect(hashBytes(SCREENSHOT)).toBe(sha256);
  });

  it("rejects a non-digest path input", () => {
    expect(() => artifactRelativePath("not-a-digest")).toThrow(/sha256/);
    expect(() => artifactIdFor("deadbeef")).toThrow(/sha256/);
  });

  it("stores bytes and resolves them back", async () => {
    const { runId } = seedRunAndJob(storage);
    const ref = await store.putBytes(SCREENSHOT, {
      kind: "screenshot",
      mediaType: "image/png",
      runId,
    });

    expect(ref.created).toBe(true);
    expect(ref.sha256).toBe(hashBytes(SCREENSHOT));
    expect(ref.bytes).toBe(SCREENSHOT.byteLength);

    const resolved = await store.resolve(ref.id);
    expect(existsSync(resolved)).toBe(true);
    expect(await fs.readFile(resolved)).toEqual(SCREENSHOT);

    const record = store.stat(ref.id);
    expect(record?.kind).toBe("screenshot");
    expect(record?.mediaType).toBe("image/png");
    expect(record?.runId).toBe(runId);
    expect(record?.bytes).toBe(SCREENSHOT.byteLength);

    expect(await store.read(ref.id)).toEqual(SCREENSHOT);
    expect(await store.verify(ref.id)).toBe(true);
  });

  it("deduplicates identical content", async () => {
    const first = await store.putBytes(SCREENSHOT, { kind: "screenshot" });
    const second = await store.putBytes(Buffer.from(SCREENSHOT), { kind: "screenshot" });

    expect(second.id).toBe(first.id);
    expect(second.sha256).toBe(first.sha256);
    expect(second.created).toBe(false);
    expect(second.absolutePath).toBe(first.absolutePath);

    // One row, one file.
    expect(storage.getArtifactBySha256(first.sha256)?.id).toBe(first.id);
    const leafDir = join(store.root, first.sha256.slice(0, 2), first.sha256.slice(2, 4));
    expect(readdirSync(leafDir)).toEqual([first.sha256]);
  });

  it("gives different content a different id", async () => {
    const a = await store.putBytes(Buffer.from("one"));
    const b = await store.putBytes(Buffer.from("two"));
    expect(a.id).not.toBe(b.id);
  });

  it("stores a temporary file by atomic rename and consumes the source", async () => {
    const temporary = join(dir, "incoming.bin");
    await fs.writeFile(temporary, SCREENSHOT);

    const ref = await store.putFile(temporary, { kind: "document", mediaType: "application/pdf" });
    expect(ref.created).toBe(true);
    expect(existsSync(temporary)).toBe(false); // moved, not copied
    expect(await fs.readFile(await store.resolve(ref.id))).toEqual(SCREENSHOT);
  });

  it("removes the source when putFile hits existing content", async () => {
    await store.putBytes(SCREENSHOT);

    const temporary = join(dir, "duplicate.bin");
    await fs.writeFile(temporary, SCREENSHOT);

    const ref = await store.putFile(temporary);
    expect(ref.created).toBe(false);
    expect(existsSync(temporary)).toBe(false);
  });

  it("leaves no partial files behind", async () => {
    await store.putBytes(SCREENSHOT);
    const tmpDir = join(store.root, ".tmp");
    if (existsSync(tmpDir)) {
      expect(readdirSync(tmpDir).filter((f) => f.endsWith(".part"))).toHaveLength(0);
    }
  });

  it("fails clearly for an unknown artifact id", async () => {
    await expect(store.resolve("0".repeat(64))).rejects.toThrow(ArtifactMissingError);
    await expect(store.read("0".repeat(64))).rejects.toThrow(/no metadata row/);
  });

  it("fails clearly when the file is gone from disk", async () => {
    const ref = await store.putBytes(SCREENSHOT);
    await fs.rm(ref.absolutePath);

    await expect(store.resolve(ref.id)).rejects.toThrow(ArtifactMissingError);
    await expect(store.read(ref.id)).rejects.toThrow(/no file at/);
  });

  it("fails clearly when the content on disk is corrupted", async () => {
    const ref = await store.putBytes(SCREENSHOT);
    await fs.writeFile(ref.absolutePath, Buffer.from("tampered"));

    await expect(store.read(ref.id)).rejects.toThrow(ArtifactCorruptedError);
    await expect(store.verify(ref.id)).rejects.toThrow(/corrupted/);
  });

  it("fails clearly when the source file does not exist", async () => {
    await expect(store.putFile(join(dir, "nope.bin"))).rejects.toThrow(/does not exist/);
  });

  it("handles empty content", async () => {
    const ref = await store.putBytes(Buffer.alloc(0));
    expect(ref.bytes).toBe(0);
    expect(await store.read(ref.id)).toEqual(Buffer.alloc(0));
  });
});

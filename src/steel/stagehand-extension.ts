// Owner: Fahad. Stagehand v4 drives the browser through its own Chrome extension. Steel's Chrome cannot load an
// extension from a local path, but Steel can install one uploaded to the organisation (sessions.create extensionIds).
// This uploads Stagehand's bundled extension once, caches the id, and hands it to sessions that will run a model.
// Verified live Sept 13: the id Steel returns is the Chrome extension id, so Stagehand connects with it directly.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import type Steel from "steel-sdk";

const EXTENSION_NAME = "Stagehand Runtime";
const cacheFile = () => path.join(process.env.PERISCOPE_DATA_DIR ?? "./data", "extensions.local.json");
let cached: string | undefined;

/** The cached id, when ensureStagehandExtension has run in this process (or a previous one wrote the cache). */
export function stagehandExtensionId(): string | undefined {
  if (cached) return cached;
  try { cached = (JSON.parse(fs.readFileSync(cacheFile(), "utf8")) as { stagehand?: string }).stagehand; } catch { /* no cache */ }
  return cached;
}

function stagehandExtensionDir(): string {
  const require = createRequire(import.meta.url);
  const pkg = require.resolve("@browserbasehq/stagehand/package.json");
  return path.join(path.dirname(pkg), "dist", "extension");
}

function zipDirectory(dir: string): string {
  const out = path.join(os.tmpdir(), `stagehand-extension-${Date.now()}.zip`);
  if (process.platform === "win32") {
    execFileSync("powershell", ["-NoProfile", "-Command", `Compress-Archive -Path '${dir}\\*' -DestinationPath '${out}'`], { stdio: "ignore" });
  } else {
    execFileSync("zip", ["-qr", out, "."], { cwd: dir, stdio: "ignore" });
  }
  return out;
}

/** Find or upload the extension. Returns undefined (and logs) when Steel refuses, so runs continue without a model. */
export async function ensureStagehandExtension(steel: Steel): Promise<string | undefined> {
  const known = stagehandExtensionId();
  if (known) return known;
  try {
    const listed = (await steel.extensions.list()) as unknown as { extensions?: Array<{ id: string; name?: string }> };
    let id = listed.extensions?.find((e) => e.name === EXTENSION_NAME)?.id;
    if (!id) {
      const zip = zipDirectory(stagehandExtensionDir());
      try { id = (await steel.extensions.upload({ file: fs.createReadStream(zip) })).id; }
      finally { fs.rmSync(zip, { force: true }); }
    }
    cached = id;
    fs.mkdirSync(path.dirname(cacheFile()), { recursive: true });
    fs.writeFileSync(cacheFile(), JSON.stringify({ stagehand: id }, null, 2));
    return id;
  } catch (e) {
    console.warn(`[stagehand] extension unavailable on Steel: ${(e as Error).message}; model-driven passes will be skipped`);
    return undefined;
  }
}

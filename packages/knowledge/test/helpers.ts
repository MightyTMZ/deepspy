/**
 * Test helpers. Deterministic fixtures only — no Steel, no Claude, no keys.
 */

import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Event, Observation, Vantage } from "@periscope/contracts";

import { Storage } from "../src/storage.js";

export function tempDir(prefix = "periscope-test-"): { path: string; cleanup: () => void } {
  const path = mkdtempSync(join(tmpdir(), prefix));
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}

/** A migrated storage on a real temp file (so WAL and FKs are exercised). */
export function tempStorage(): { storage: Storage; dir: string; cleanup: () => void } {
  const dir = tempDir();
  const storage = Storage.open({ path: join(dir.path, "periscope.db") });
  storage.migrate();
  return {
    storage,
    dir: dir.path,
    cleanup: () => {
      if (!storage.closed) storage.close();
      dir.cleanup();
    },
  };
}

export const DESKTOP_CA: Vantage = { country: "CA", device: "desktop", authenticated: false };
export const MOBILE_DE: Vantage = { country: "DE", device: "mobile", authenticated: false };
export const INTERIOR_CA: Vantage = { country: "CA", device: "desktop", authenticated: true };

/**
 * Deterministic observation id, matching the contract's documented recipe:
 * sha256(competitor|url|vantage|normalizedText).
 */
export function observationId(
  competitor: string,
  url: string,
  vantage: Vantage,
  normalizedText: string,
): string {
  const vantageKey = [
    vantage.country ?? "",
    vantage.region ?? "",
    vantage.device,
    vantage.authenticated ? "auth" : "anon",
  ].join(",");
  return createHash("sha256")
    .update([competitor, url, vantageKey, normalizedText].join("|"))
    .digest("hex");
}

export interface ObservationOverrides {
  competitor?: string;
  url?: string;
  text?: string;
  vantage?: Vantage;
  layer?: Observation["layer"];
  source?: Observation["source"];
  kind?: Observation["kind"];
  perception?: Observation["perception"];
  missedByFetch?: boolean;
  revealedBy?: Observation["revealedBy"];
  capturedAt?: string;
  id?: string;
}

export function makeObservation(
  runId: string,
  jobId: string,
  overrides: ObservationOverrides = {},
): Observation {
  const competitor = overrides.competitor ?? "ornn";
  const url = overrides.url ?? "https://ornn.com/regulatory";
  const text = overrides.text ?? "Service Level Agreement";
  const vantage = overrides.vantage ?? DESKTOP_CA;

  const base: Observation = {
    id: overrides.id ?? observationId(competitor, url, vantage, text),
    runId,
    jobId,
    competitor,
    url,
    layer: overrides.layer ?? "hidden",
    source: overrides.source ?? "browser",
    kind: overrides.kind ?? "document",
    text,
    vantage,
    perception: overrides.perception ?? "dom",
    capturedAt: overrides.capturedAt ?? "2026-09-13T00:00:00.000Z",
  };

  if (overrides.missedByFetch !== undefined) base.missedByFetch = overrides.missedByFetch;
  if (overrides.revealedBy !== undefined) base.revealedBy = overrides.revealedBy;
  else if ((overrides.layer ?? "hidden") === "hidden") {
    base.revealedBy = { action: "click", label: "Service Level Agreement" };
  }

  return base;
}

export function observationEvent(observation: Observation): Event {
  return { type: "observation", data: observation };
}

/** A run plus one job, the minimum association scaffolding for events. */
export function seedRunAndJob(
  storage: Storage,
  runId = "run-1",
  jobId = "job-1",
  competitor = "ornn",
): { runId: string; jobId: string } {
  storage.createRun({ id: runId, goal: "coverage gap", category: "legal", capUsd: 75 });
  storage.createJob({
    id: jobId,
    runId,
    purpose: "reveal",
    competitor,
    url: "https://ornn.com/regulatory",
  });
  return { runId, jobId };
}

/** The four documents the reveal pass finds on Ornn's regulatory page. */
export const ORNN_DOCUMENTS: readonly string[] = [
  "Privacy Policy",
  "Service Level Agreement",
  "Terms of Service",
  "Acceptable Use Policy",
];

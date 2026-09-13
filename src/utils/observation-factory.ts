import { createHash } from "node:crypto";
import type {
  Observation,
  Vantage,
  Layer,
  Source,
} from "@periscope/contracts";
import { normalizeText } from "./text.js";

export interface ObservationInput {
  runId: string;
  jobId: string;
  competitor: string;
  url: string;
  layer: Layer;
  source: Source;
  kind: Observation["kind"];
  text: string;
  revealedBy?: Observation["revealedBy"];
  vantage: Vantage;
  perception: Observation["perception"];
  screenshotPath?: string;
  steelSessionId?: string;
  viewerUrl?: string;
}

function observationId(
  competitor: string,
  url: string,
  vantage: Vantage,
  normalizedText: string,
): string {
  const input = [
    competitor,
    url,
    JSON.stringify(vantage),
    normalizedText,
  ].join("|");
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Create an Observation with a deterministic sha256 id.
 */
export function createObservation(input: ObservationInput): Observation {
  const normalized = normalizeText(input.text);
  return {
    id: observationId(input.competitor, input.url, input.vantage, normalized),
    runId: input.runId,
    jobId: input.jobId,
    competitor: input.competitor,
    url: input.url,
    layer: input.layer,
    source: input.source,
    kind: input.kind,
    text: normalized,
    revealedBy: input.revealedBy,
    vantage: input.vantage,
    perception: input.perception,
    missedByFetch: undefined,
    screenshotPath: input.screenshotPath,
    steelSessionId: input.steelSessionId,
    viewerUrl: input.viewerUrl,
    capturedAt: new Date().toISOString(),
  };
}

/**
 * Check if text was present in the surface baseline. If not, mark missedByFetch.
 */
export function markMissedByFetch(
  obs: Observation,
  surfaceText: string,
): Observation {
  const surfaceNormalized = normalizeText(surfaceText);
  const missed = !surfaceNormalized.includes(obs.text);
  return { ...obs, missedByFetch: missed };
}

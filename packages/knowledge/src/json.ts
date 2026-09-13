/**
 * Runtime validation for JSON crossing the SQLite boundary.
 *
 * Rows store the full contract payload as JSON. On the way back out it is
 * `unknown` until proven otherwise — these guards prove it. They VALIDATE the
 * frozen contract shapes; they do not redefine them. The only source of the
 * types is @periscope/contracts.
 */

import type {
  ActionReceipt,
  Device,
  Event,
  JobState,
  Layer,
  Observation,
  Source,
  Vantage,
} from "@periscope/contracts";

export class ValidationError extends Error {
  readonly path: string;
  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "ValidationError";
    this.path = path;
  }
}

const LAYERS: readonly string[] = ["surface", "hidden", "borders", "interior"];
const SOURCES: readonly string[] = ["steel_scrape", "browser", "benchmark_fetch"];
const DEVICES: readonly string[] = ["desktop", "mobile"];
const KINDS: readonly string[] = [
  "text", "option", "price", "document", "image_text", "tooltip", "screen", "link",
];
const PERCEPTIONS: readonly string[] = ["dom", "a11y", "screenshot"];
const ACTIONS: readonly string[] = [
  "click", "hover", "select", "toggle", "scroll", "login", "none",
];
const JOB_STATES: readonly string[] = [
  "queued", "starting", "running", "awaiting_human",
  "finalizing", "completed", "partial", "failed", "cancelled",
];
const WALLS: readonly string[] = [
  "captcha", "2fa", "email_code", "kyc", "payment", "consent", "unknown_form", "login",
];
const HANDOFF_STATES: readonly string[] = ["awaiting_human", "resumed", "abandoned"];
const EVENT_TYPES: readonly string[] = [
  "observation", "receipt", "counter", "handoff", "job_state", "spend", "run_done",
];

export const JOB_STATE_VALUES: readonly JobState[] = JOB_STATES as readonly JobState[];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown, path: string): string {
  if (typeof value !== "string") throw new ValidationError(path, "expected string");
  return value;
}

function nonEmptyStr(value: unknown, path: string): string {
  const s = str(value, path);
  if (s.length === 0) throw new ValidationError(path, "expected non-empty string");
  return s;
}

function optStr(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  return str(value, path);
}

function num(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ValidationError(path, "expected finite number");
  }
  return value;
}

function bool(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new ValidationError(path, "expected boolean");
  return value;
}

function member<T extends string>(value: unknown, allowed: readonly string[], path: string): T {
  const s = str(value, path);
  if (!allowed.includes(s)) {
    throw new ValidationError(path, `expected one of ${allowed.join("|")}, received ${s}`);
  }
  return s as T;
}

/** Parse JSON text, failing with a clear error rather than throwing SyntaxError. */
export function parseJson(text: string, path: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (cause) {
    throw new ValidationError(path, `invalid JSON (${(cause as Error).message})`);
  }
}

export function assertVantage(value: unknown, path = "vantage"): asserts value is Vantage {
  if (!isRecord(value)) throw new ValidationError(path, "expected object");
  const country = value["country"];
  if (country !== null && typeof country !== "string") {
    throw new ValidationError(`${path}.country`, "expected string or null");
  }
  const region = value["region"];
  if (region !== undefined && region !== null && typeof region !== "string") {
    throw new ValidationError(`${path}.region`, "expected string, null or undefined");
  }
  member<Device>(value["device"], DEVICES, `${path}.device`);
  bool(value["authenticated"], `${path}.authenticated`);
}

export function assertObservation(value: unknown, path = "observation"): asserts value is Observation {
  if (!isRecord(value)) throw new ValidationError(path, "expected object");

  nonEmptyStr(value["id"], `${path}.id`);
  nonEmptyStr(value["runId"], `${path}.runId`);
  nonEmptyStr(value["jobId"], `${path}.jobId`);
  nonEmptyStr(value["competitor"], `${path}.competitor`);
  nonEmptyStr(value["url"], `${path}.url`);
  member<Layer>(value["layer"], LAYERS, `${path}.layer`);
  member<Source>(value["source"], SOURCES, `${path}.source`);
  member(value["kind"], KINDS, `${path}.kind`);
  str(value["text"], `${path}.text`);
  member(value["perception"], PERCEPTIONS, `${path}.perception`);
  nonEmptyStr(value["capturedAt"], `${path}.capturedAt`);
  assertVantage(value["vantage"], `${path}.vantage`);

  const revealedBy = value["revealedBy"];
  if (revealedBy !== undefined) {
    if (!isRecord(revealedBy)) throw new ValidationError(`${path}.revealedBy`, "expected object");
    member(revealedBy["action"], ACTIONS, `${path}.revealedBy.action`);
    optStr(revealedBy["label"], `${path}.revealedBy.label`);
    optStr(revealedBy["selector"], `${path}.revealedBy.selector`);
    const coords = revealedBy["coords"];
    if (coords !== undefined) {
      if (!Array.isArray(coords) || coords.length !== 2) {
        throw new ValidationError(`${path}.revealedBy.coords`, "expected [number, number]");
      }
      num(coords[0], `${path}.revealedBy.coords[0]`);
      num(coords[1], `${path}.revealedBy.coords[1]`);
    }
  }

  const missed = value["missedByFetch"];
  if (missed !== undefined) bool(missed, `${path}.missedByFetch`);

  optStr(value["screenshotPath"], `${path}.screenshotPath`);
  optStr(value["steelSessionId"], `${path}.steelSessionId`);
  optStr(value["viewerUrl"], `${path}.viewerUrl`);

  const trace = value["traceRange"];
  if (trace !== undefined) {
    if (!isRecord(trace)) throw new ValidationError(`${path}.traceRange`, "expected object");
    str(trace["start"], `${path}.traceRange.start`);
    str(trace["end"], `${path}.traceRange.end`);
  }
}

export function assertActionReceipt(value: unknown, path = "receipt"): asserts value is ActionReceipt {
  if (!isRecord(value)) throw new ValidationError(path, "expected object");
  nonEmptyStr(value["jobId"], `${path}.jobId`);
  const step = num(value["step"], `${path}.step`);
  if (!Number.isInteger(step) || step < 0) {
    throw new ValidationError(`${path}.step`, "expected non-negative integer");
  }
  nonEmptyStr(value["action"], `${path}.action`);
  optStr(value["target"], `${path}.target`);
  str(value["before"], `${path}.before`);
  str(value["after"], `${path}.after`);
  bool(value["ok"], `${path}.ok`);
  num(value["tokensIn"], `${path}.tokensIn`);
  num(value["tokensOut"], `${path}.tokensOut`);
  num(value["usd"], `${path}.usd`);
}

export function assertEvent(value: unknown, path = "event"): asserts value is Event {
  if (!isRecord(value)) throw new ValidationError(path, "expected object");
  const type = member(value["type"], EVENT_TYPES, `${path}.type`);
  const data = value["data"];
  if (!isRecord(data)) throw new ValidationError(`${path}.data`, "expected object");

  switch (type) {
    case "observation":
      assertObservation(data, `${path}.data`);
      return;
    case "receipt":
      assertActionReceipt(data, `${path}.data`);
      return;
    case "counter": {
      nonEmptyStr(data["competitor"], `${path}.data.competitor`);
      nonEmptyStr(data["url"], `${path}.data.url`);
      const missed = data["missed"];
      if (missed !== "uncertain") {
        const n = num(missed, `${path}.data.missed`);
        if (!Number.isInteger(n) || n < 0) {
          throw new ValidationError(`${path}.data.missed`, 'expected non-negative integer or "uncertain"');
        }
      }
      return;
    }
    case "handoff": {
      nonEmptyStr(data["jobId"], `${path}.data.jobId`);
      nonEmptyStr(data["viewerUrl"], `${path}.data.viewerUrl`);
      member(data["wall"], WALLS, `${path}.data.wall`);
      num(data["generation"], `${path}.data.generation`);
      member(data["state"], HANDOFF_STATES, `${path}.data.state`);
      return;
    }
    case "job_state": {
      nonEmptyStr(data["jobId"], `${path}.data.jobId`);
      member<JobState>(data["state"], JOB_STATES, `${path}.data.state`);
      optStr(data["reason"], `${path}.data.reason`);
      return;
    }
    case "spend": {
      nonEmptyStr(data["runId"], `${path}.data.runId`);
      num(data["usd"], `${path}.data.usd`);
      num(data["cap"], `${path}.data.cap`);
      return;
    }
    case "run_done":
      nonEmptyStr(data["runId"], `${path}.data.runId`);
      return;
    default: {
      const exhaustive: never = type as never;
      throw new ValidationError(path, `unhandled event type ${String(exhaustive)}`);
    }
  }
}

/** Read an observation payload column back out as a validated contract type. */
export function parseObservationPayload(text: string, path = "observation"): Observation {
  const value = parseJson(text, path);
  assertObservation(value, path);
  return value;
}

/** Read an event payload column back out as a validated contract type. */
export function parseEventPayload(text: string, path = "event"): Event {
  const value = parseJson(text, path);
  assertEvent(value, path);
  return value;
}

/** Parse a JSON string array column (e.g. findings.observation_ids). */
export function parseStringArray(text: string, path: string): string[] {
  const value = parseJson(text, path);
  if (!Array.isArray(value)) throw new ValidationError(path, "expected array");
  return value.map((entry, index) => str(entry, `${path}[${index}]`));
}

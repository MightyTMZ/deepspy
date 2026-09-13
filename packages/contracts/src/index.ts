// packages/contracts/src/index.ts
//
// FROZEN SHARED CONTRACTS.
//
// Transcribed verbatim from periscope-final-architecture.md section 5
// ("Shared contracts, frozen Friday night"). This is the one shared package.
//
// Rules (section 4):
//   - This package lands on `main` first. After that, any change needs all
//     three owners on the pull request.
//   - Do NOT add owner-specific types here. Do NOT re-declare these types
//     anywhere else in the repo. Import them.

export type Layer = "surface" | "hidden" | "borders" | "interior";
export type Source = "steel_scrape" | "browser" | "benchmark_fetch";
export type Device = "desktop" | "mobile";

export interface Vantage { country: string | null; region?: string | null; device: Device; authenticated: boolean; }

export interface Observation {
  id: string;                       // sha256(competitor|url|vantage|normalizedText)
  runId: string; jobId: string; competitor: string; url: string;
  layer: Layer; source: Source;
  kind: "text" | "option" | "price" | "document" | "image_text" | "tooltip" | "screen" | "link";
  text: string;                     // normalized: whitespace collapsed, nav duplicates removed
  revealedBy?: { action: "click" | "hover" | "select" | "toggle" | "scroll" | "login" | "none"; label?: string; selector?: string; coords?: [number, number] };
  vantage: Vantage;
  perception: "dom" | "a11y" | "screenshot";   // which rung of the ladder produced it
  missedByFetch?: boolean;          // hidden layer only; set by B against the surface baseline
  screenshotPath?: string; steelSessionId?: string; viewerUrl?: string;
  traceRange?: { start: string; end: string };
  capturedAt: string;
}

export interface SessionHandle {   // C provides, B consumes
  sessionId: string; viewerUrl: string; vantage: Vantage; profileId?: string;
  page: import("playwright-core").Page;
  deadlineAt: string;               // autonomous work must stop by this time
  release(): Promise<void>;
  checkpoint(state: unknown): Promise<void>;
}

export interface LeaseRequest { vantage: Vantage; profileId?: string; accountRef?: string; purpose: "surface" | "reveal" | "borders" | "walker" | "setup"; }

export interface WallDetected {    // B or C raises, C handles
  jobId: string; sessionId: string;
  wall: "captcha" | "2fa" | "email_code" | "kyc" | "payment" | "consent" | "unknown_form" | "login";
  screenshotPath: string; generation: number;
}

export interface HandoffEvent { jobId: string; viewerUrl: string; wall: WallDetected["wall"]; generation: number; state: "awaiting_human" | "resumed" | "abandoned"; }

export interface ActionReceipt { jobId: string; step: number; action: string; target?: string; before: string; after: string; ok: boolean; tokensIn: number; tokensOut: number; usd: number; }

export type JobState = "queued" | "starting" | "running" | "awaiting_human" | "finalizing" | "completed" | "partial" | "failed" | "cancelled";

export type Event =
  | { type: "observation"; data: Observation }
  | { type: "receipt"; data: ActionReceipt }
  | { type: "counter"; data: { competitor: string; url: string; missed: number | "uncertain" } }
  | { type: "handoff"; data: HandoffEvent }
  | { type: "job_state"; data: { jobId: string; state: JobState; reason?: string } }
  | { type: "spend"; data: { runId: string; usd: number; cap: number } }
  | { type: "run_done"; data: { runId: string } };

// End-to-end entry point: Storage (Ayaan) + Steel segment (Fahad) + Coordinator (Tom), wired through the contracts.
// This is the command the integration tests I1 to I5 run. Frontend and Ayaan's API consume the same Storage.
//
//   STEEL_API_KEY=... ANTHROPIC_API_KEY=... npx tsx src/run.ts \
//     --competitor ornn --url https://ornn.com --pages /regulatory,/product \
//     --jobs surface,benchmark,reveal --countries CA,US,DE --cap 12
//
//   add --profile <profileId> --account trial1 --start https://app.example.com to enqueue a walker.
//
// A handoff prints the viewer URL; a human resolves it in the live view and then:
//   curl -X POST http://localhost:4747/jobs/<jobId>/resume
//
// Never commits credentials. Never creates accounts. Releases every session it opened, even on Ctrl+C.

import path from "node:path";
import { Storage } from "@periscope/knowledge";
import { Coordinator, type JobType } from "./coordinator.js";
import { createSteelSegment } from "./steel/segment.js";
import { StorageSink } from "./integration/storage-sink.js";
import { startResumeServer } from "./integration/resume-server.js";
import type { Event, EventSink, Vantage } from "@periscope/contracts";

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  if (v === undefined && fallback === undefined) throw new Error(`--${name} is required`);
  return v ?? (fallback as string);
}

const competitor = arg("competitor");
const root = arg("url");
const pages = arg("pages", "/").split(",").map((p) => {
  const raw = p.trim();
  // Git Bash on Windows rewrites a leading "/" argument into "C:/Program Files/Git/..." before Node sees it.
  if (/^[a-z]:[\/]/i.test(raw) || raw.startsWith("file:")) throw new Error(`page "${raw}" looks like a local path. Run with MSYS_NO_PATHCONV=1 or pass full URLs.`);
  return new URL(raw, root).toString();
});
const jobTypes = arg("jobs", "surface,benchmark,reveal").split(",").map((s) => s.trim()) as JobType[];
const countries = arg("countries", "CA,US,DE").split(",").map((s) => s.trim()).filter(Boolean);
const capUsd = Number(arg("cap", "12"));
const runId = arg("run-id", `run-${Date.now()}`);
const profileId = process.argv.includes("--profile") ? arg("profile") : undefined;
const accountRef = process.argv.includes("--account") ? arg("account") : undefined;
const startUrl = process.argv.includes("--start") ? arg("start") : undefined;

const dataDir = process.env.PERISCOPE_DATA_DIR ?? "./data";
const storage = Storage.open({ path: path.join(dataDir, "periscope.sqlite") });
storage.migrate();

const jobHints = new Map<string, { purpose: "surface" | "reveal" | "borders" | "walker" | "setup"; competitor: string; url?: string }>();
const sink: EventSink = new StorageSink({ storage, runId, category: "demo", capUsd, jobHints: (id) => jobHints.get(id) });
const tee: EventSink = { async write(event: Event) { await sink.write(event); logEvent(event); } };

const segment = createSteelSegment({ sink: tee });
const released = await segment.reconcile();
if (released.length) console.log(`reconciled ${released.length} session(s) left open by a previous run`);

const resume = startResumeServer({ segment });
console.log(`resume endpoint: http://localhost:${resume.port}/jobs/<jobId>/resume`);

const coordinator = new Coordinator({
  runId, runBudgetUsd: capUsd, jobBudgetUsd: Math.min(capUsd, 4), runStartedAt: new Date().toISOString(),
  sink: tee, acquireSession: segment.acquireSession, steel: segment.steel,
  onWall: async (wall, handle) => {
    const out = await segment.onWall(wall, handle);
    if (out.state === "awaiting_human") resume.recordHandoff(out);
    return out;
  },
  waitForResolution: segment.waitForResolution,
});

const desktop: Vantage = { country: null, device: "desktop", authenticated: false };
const jobs: Parameters<Coordinator["enqueue"]>[0] = [];
for (const t of jobTypes) {
  if (t === "surface" || t === "benchmark" || t === "reveal") jobs.push({ type: t, competitor, urls: pages, vantage: desktop });
  if (t === "borders") jobs.push({ type: "borders", competitor, urls: [pages[0]], vantages: countries.flatMap((c) => [{ country: c, device: "desktop", authenticated: false }, { country: c, device: "mobile", authenticated: false }] as Vantage[]) });
  if (t === "walker") {
    if (!startUrl) throw new Error("--start is required for a walker job");
    jobs.push({ type: "walker", competitor, urls: [startUrl], vantage: { country: countries[0] ?? null, device: "desktop", authenticated: true }, profileId, accountRef });
  }
}
coordinator.enqueue(jobs);
for (const j of coordinator.getState().queued) jobHints.set(j.id, { purpose: j.type === "walker" ? "walker" : j.type === "borders" ? "borders" : j.type === "reveal" ? "reveal" : "surface", competitor, url: j.urls[0] });

const shutdown = async () => { console.log("shutting down, releasing sessions..."); resume.close(); storage.close(); process.exit(130); };
process.on("SIGINT", () => void shutdown());

const t0 = Date.now();
const result = await coordinator.run();
await tee.write({ type: "run_done", data: { runId } });
console.log(`\nrun ${runId} done in ${Math.round((Date.now() - t0) / 1000)}s: ${result.completedJobs.length} completed, ${result.failedJobs.length} failed`);
console.log(`observations: ${storage.countObservations(runId)}  events: ${storage.countEvents(runId)}  spend: $${(storage.runSpendMicroUsd(runId) / 1e6).toFixed(2)}`);
resume.close();
storage.close();

function logEvent(e: Event): void {
  switch (e.type) {
    case "job_state": console.log(`[job ${e.data.jobId.slice(0, 8)}] ${e.data.state}${e.data.reason ? " (" + e.data.reason + ")" : ""}`); break;
    case "handoff": console.log(`[handoff] ${e.data.state} ${e.data.wall} job ${e.data.jobId.slice(0, 8)} generation ${e.data.generation}\n  live view: ${e.data.viewerUrl}`); break;
    case "counter": console.log(`[counter] ${e.data.url} missed by fetch: ${e.data.missed}`); break;
    case "spend": console.log(`[spend] $${e.data.usd.toFixed(3)} of $${e.data.cap}`); break;
    case "observation": if (e.data.missedByFetch) console.log(`[hidden] ${e.data.revealedBy?.label ?? e.data.revealedBy?.action ?? ""}: ${e.data.text.slice(0, 80)}`); break;
    default: break;
  }
}

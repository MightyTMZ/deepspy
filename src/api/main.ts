// API entry point: npx tsx src/api/main.ts  (PERISCOPE_API_PORT, PERISCOPE_DATA_DIR, STEEL_API_KEY)
// Without STEEL_API_KEY every read endpoint still works from SQLite; POST /runs and account setups answer 503.
import path from "node:path";
import { Storage } from "@periscope/knowledge";
import { createSteelSegment } from "../steel/segment.js";
import { RouterSink, launchRun } from "../integration/launch-run.js";
import { createApi } from "./server.js";
import { anthropicComplete, extractFeatures } from "../intel/extract.js";

const dataDir = process.env.PERISCOPE_DATA_DIR ?? "./data";
const storage = Storage.open({ path: path.join(dataDir, "periscope.sqlite") });
storage.migrate();

const hasSteel = Boolean(process.env.STEEL_API_KEY);
const complete = process.env.ANTHROPIC_API_KEY ? anthropicComplete() : undefined;
const autoExtract = Boolean(complete) && process.env.PERISCOPE_AUTO_EXTRACT !== "0";
const router = new RouterSink();
const segment = hasSteel ? createSteelSegment({ sink: router }) : undefined;
if (segment) {
  const released = await segment.reconcile();
  if (released.length) console.log(`reconciled ${released.length} session(s) left open by a previous run`);
}

const api = await createApi({
  storage,
  complete,
  segment: segment ? { resume: segment.resume, acquireSession: segment.acquireSession, profileStatus: (id) => segment.adapter.profileStatus(id) } : undefined,
  launch: segment ? (spec) => launchRun(spec, {
    storage, segment, router,
    onEvent: (e) => { if (e.type === "job_state") console.log(`[${spec.runId}] job ${e.data.jobId.slice(0, 8)} ${e.data.state}${e.data.reason ? " (" + e.data.reason + ")" : ""}`); if (e.type === "counter") console.log(`[${spec.runId}] ${e.data.url} missed by fetch: ${e.data.missed}`); },
    onHandoff: (h) => { api.recordHandoff(h); console.log(`[${spec.runId}] handoff ${h.state} ${h.wall} job ${h.jobId.slice(0, 8)} -> ${h.viewerUrl}`); },
  }) : undefined,
});
if (autoExtract) {
  // After a run finishes, fill the matrix so the frontend has rows without a manual step. Costs one model call per competitor.
  const seen = new Set<string>();
  const startedAt = new Date().toISOString();
  setInterval(() => {
    for (const r of storage.listRuns(20)) {
      if (r.status !== "completed" || r.createdAt < startedAt || seen.has(r.id) || storage.getFindingsByRun(r.id, "feature").length > 0) continue;
      seen.add(r.id);
      const competitors = [...new Set(storage.getJobsByRun(r.id).map((j) => j.competitor).filter((x): x is string => Boolean(x)))];
      for (const competitor of competitors) extractFeatures({ storage, runId: r.id, competitor, complete: complete! }).then((x) => console.log(`[${r.id}] matrix ${competitor}: ${x.rows.length} rows, ${x.findings.length} findings, ${x.tokensIn}+${x.tokensOut} tokens`), (e) => console.warn(`[${r.id}] extract failed: ${(e as Error).message}`));
    }
  }, 5000).unref();
}
console.log(`periscope api on http://localhost:${api.port} (steel ${hasSteel ? "on" : "off, read-only"}, model ${complete ? "on" : "off"}); contract in docs/api.md`);

const shutdown = async () => { console.log("shutting down"); await api.close(); storage.close(); process.exit(130); };
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

// Inspect a run in the SQLite system of record. Usage: npx tsx scripts/inspect-run.ts <runId> [<runId>...]
import path from "node:path";
import { Storage } from "@periscope/knowledge";

const storage = Storage.open({ path: path.join(process.env.PERISCOPE_DATA_DIR ?? "./data", "periscope.sqlite"), readonly: true });
const ids = process.argv.slice(2);
if (ids.length === 0) { console.log("usage: inspect-run <runId>..."); process.exit(1); }
for (const runId of ids) {
  const run = storage.getRun(runId);
  if (!run) { console.log(`${runId}: not found`); continue; }
  const obs = storage.getObservationsByRun(runId);
  const hidden = obs.filter((o) => o.layer === "hidden");
  const missed = hidden.filter((o) => o.missedByFetch);
  const byLabel: Record<string, number> = {};
  for (const o of hidden) { const k = o.revealedBy?.label ?? o.revealedBy?.action ?? "?"; byLabel[k] = (byLabel[k] ?? 0) + 1; }
  const byKind: Record<string, number> = {};
  for (const o of hidden) byKind[o.kind] = (byKind[o.kind] ?? 0) + 1;
  const byVantage: Record<string, number> = {};
  for (const o of obs) { const k = `${o.vantage.country ?? "-"}/${o.vantage.device}`; byVantage[k] = (byVantage[k] ?? 0) + 1; }
  console.log(`\n== ${runId} (${run.status}) ==`);
  const interior = obs.filter((o) => o.layer === "interior");
  console.log(`observations ${obs.length} | surface ${obs.filter((o) => o.layer === "surface").length} | benchmark ${obs.filter((o) => o.source === "benchmark_fetch").length} | hidden ${hidden.length} | missedByFetch ${missed.length} | borders ${obs.filter((o) => o.layer === "borders").length} | interior ${interior.length} (${new Set(interior.map((o) => o.url)).size} screens) | events ${storage.countEvents(runId)} | handoffs ${storage.countEvents(runId, "handoff")} | spend $${(storage.runSpendMicroUsd(runId) / 1e6).toFixed(2)}`);
  console.log("hidden by action:", Object.entries(byLabel).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([k, v]) => `${k}=${v}`).join(", "));
  console.log("hidden by kind:  ", Object.entries(byKind).map(([k, v]) => `${k}=${v}`).join(", "));
  console.log("by vantage:      ", Object.entries(byVantage).map(([k, v]) => `${k}=${v}`).join(", "));
  const jobs = storage.getJobsByRun(runId);
  console.log("jobs:", jobs.map((j) => `${j.purpose}:${j.state}`).join(", "));
}
storage.close();

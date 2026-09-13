// Extract the feature matrix for a run with Claude. Usage: ANTHROPIC_API_KEY=... npx tsx scripts/extract.ts <runId> [competitor]
import path from "node:path";
import { Storage } from "@periscope/knowledge";
import { anthropicComplete, extractFeatures } from "../src/intel/extract.js";

const [runId, competitorArg] = process.argv.slice(2);
if (!runId) { console.log("usage: extract <runId> [competitor]"); process.exit(1); }
if (!process.env.ANTHROPIC_API_KEY) { console.log("ANTHROPIC_API_KEY is required"); process.exit(1); }
const storage = Storage.open({ path: path.join(process.env.PERISCOPE_DATA_DIR ?? "./data", "periscope.sqlite") });
storage.migrate();
const competitors = competitorArg ? [competitorArg] : [...new Set(storage.getJobsByRun(runId).map((j) => j.competitor).filter((c): c is string => Boolean(c)))];
for (const competitor of competitors) {
  const t0 = Date.now();
  const r = await extractFeatures({ storage, runId, competitor, complete: anthropicComplete() });
  console.log(`\n${competitor}: ${r.rows.length} rows, ${r.rejected} rejected, ${r.findings.length} findings, ${r.tokensIn}+${r.tokensOut} tokens, ${Math.round((Date.now() - t0) / 1000)}s`);
  for (const row of r.rows) console.log(`  ${row.status.padEnd(8)} ${row.feature.padEnd(32)} ${row.value ?? ""}  [${row.evidenceIds.length} evidence]`);
}
storage.close();

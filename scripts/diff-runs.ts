// Diff two runs of the same competitor. Usage: npx tsx scripts/diff-runs.ts <fromRunId> <toRunId>
import path from "node:path";
import { Storage } from "@periscope/knowledge";
import { diffRuns, renderDiff } from "../src/intel/diff.js";
import { coverage, renderCoverage } from "../src/intel/coverage.js";

const [fromId, toId] = process.argv.slice(2);
if (!fromId) { console.log("usage: diff-runs <fromRunId> [toRunId]"); process.exit(1); }
const storage = Storage.open({ path: path.join(process.env.PERISCOPE_DATA_DIR ?? "./data", "periscope.sqlite"), readonly: true });
if (!toId) {
  console.log(renderCoverage(coverage(fromId, storage.getObservationsByRun(fromId))));
} else {
  console.log(renderCoverage(coverage(toId, storage.getObservationsByRun(toId))));
  console.log();
  console.log(renderDiff(diffRuns(fromId, storage.getObservationsByRun(fromId), toId, storage.getObservationsByRun(toId))));
}
storage.close();

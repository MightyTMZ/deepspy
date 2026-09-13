// Print the borders grid for a run. Usage: npx tsx scripts/borders-grid.ts <runId> [url]
import path from "node:path";
import { Storage } from "@periscope/knowledge";
import { bordersGrid, renderGrid } from "../src/intel/borders-grid.js";

const [runId, urlArg] = process.argv.slice(2);
if (!runId) { console.log("usage: borders-grid <runId> [url]"); process.exit(1); }
const storage = Storage.open({ path: path.join(process.env.PERISCOPE_DATA_DIR ?? "./data", "periscope.sqlite"), readonly: true });
const obs = storage.getObservationsByRun(runId, { layer: "borders" });
const urls = urlArg ? [urlArg] : [...new Set(obs.map((o) => o.url))];
if (urls.length === 0) console.log(`${runId}: no borders observations`);
for (const url of urls) console.log(renderGrid(bordersGrid(url, obs)) + "\n");
storage.close();

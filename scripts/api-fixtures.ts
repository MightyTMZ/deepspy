// Generate fixture responses for every API route into fixtures/api/*.json (A18: the frontend builds from these).
// Uses an in-memory store seeded with realistic rows; no keys needed. Usage: npx tsx scripts/api-fixtures.ts
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Storage } from "@periscope/knowledge";
import type { Observation } from "@periscope/contracts";
import { createApi } from "../src/api/server.js";
import { StorageSink } from "../src/integration/storage-sink.js";

const storage = Storage.open({ path: ":memory:" }); storage.migrate();
const obs = (runId: string, jobId: string, url: string, text: string, over: Partial<Observation> = {}): Observation => ({
  id: `${runId}|${jobId}|${url}|${JSON.stringify(over.vantage ?? "")}|${text}`, runId, jobId, competitor: "ornn", url,
  layer: "surface", source: "browser", kind: "text", text, vantage: { country: null, device: "desktop", authenticated: false },
  perception: "dom", capturedAt: new Date().toISOString(), ...over,
});
const REG = "https://ornn.com/regulatory", PREM = "https://www.spotify.com/premium/";
async function seed(runId: string, price: string) {
  const sink = new StorageSink({ storage, runId, category: "demo", capUsd: 12, jobHints: (id) => ({ purpose: id.includes("border") ? "borders" : "reveal", competitor: "ornn", url: id.includes("border") ? PREM : REG }) });
  const j = `${runId}-reveal`, b = `${runId}-borders`;
  await sink.write({ type: "job_state", data: { jobId: j, state: "running" } });
  for (const t of ["Regulatory", "Ornn is built for compliance teams", "Overview", "Legal"]) await sink.write({ type: "observation", data: obs(runId, j, REG, t) });
  for (const t of ["Service Level Agreement", "Terms of Service", "Acceptable Use Policy"]) await sink.write({ type: "observation", data: obs(runId, j, REG, t, { layer: "hidden", missedByFetch: true, revealedBy: { action: "click", label: "Legal" }, steelSessionId: "sess-1", viewerUrl: "https://app.steel.dev/sessions/sess-1" }) });
  await sink.write({ type: "observation", data: obs(runId, j, REG, "https://ornn.com/docs/ornn-sla.docx", { layer: "hidden", kind: "document", missedByFetch: true, revealedBy: { action: "click", label: "Legal" }, screenshotPath: "data/walls/example.png" }) });
  await sink.write({ type: "counter", data: { competitor: "ornn", url: REG, missed: 4 } });
  await sink.write({ type: "job_state", data: { jobId: j, state: "completed" } });
  await sink.write({ type: "job_state", data: { jobId: b, state: "running" } });
  const rows: Array<[string, string, string]> = [["CA", "desktop", "$13.99 / month after. Cancel anytime."], ["CA", "mobile", "$13.99 / month after. Cancel anytime."], ["US", "desktop", price], ["US", "mobile", price], ["DE", "desktop", "Danach 12,99 €/Monat"], ["DE", "mobile", "Danach 12,99 €/Monat"], ["US", "desktop", "Spotify Premium Student offer currently includes access to Hulu"]];
  for (const [country, device, t] of rows) await sink.write({ type: "observation", data: obs(runId, b, PREM, t, { layer: "borders", vantage: { country, device: device as "desktop" | "mobile", authenticated: false } }) });
  for (const [country, device] of [["CA", "desktop"], ["US", "desktop"], ["DE", "desktop"]]) await sink.write({ type: "observation", data: obs(runId, b, PREM, "Premium Individual", { layer: "borders", vantage: { country, device: device as "desktop", authenticated: false } }) });
  await sink.write({ type: "handoff", data: { jobId: b, viewerUrl: "https://app.steel.dev/sessions/sess-2", wall: "captcha", generation: 1, state: "awaiting_human" } });
  await sink.write({ type: "handoff", data: { jobId: b, viewerUrl: "https://app.steel.dev/sessions/sess-2", wall: "captcha", generation: 1, state: "resumed" } });
  await sink.write({ type: "receipt", data: { jobId: j, step: 1, action: "extract", target: "Legal tab", before: "sha-before", after: "sha-after", ok: true, tokensIn: 1200, tokensOut: 300, usd: 0.42 } });
  await sink.write({ type: "job_state", data: { jobId: b, state: "completed" } });
  await sink.write({ type: "run_done", data: { runId } });
}
await seed("run-friday", "$11.99 / month after");
await seed("run-saturday", "$12.99 / month after");
storage.createFinding({ id: "finding-sla", runId: "run-saturday", competitor: "ornn", kind: "feature", title: "Service level agreement published", status: "observed", value: "SLA docx behind the Legal tab", observationIds: ["run-saturday|run-saturday-reveal|https://ornn.com/regulatory|\"\"|Service Level Agreement", "run-saturday|run-saturday-reveal|https://ornn.com/regulatory|\"\"|https://ornn.com/docs/ornn-sla.docx"] });
storage.recordArtifact({ id: "artifact-1", sha256: "0".repeat(64), path: "data/walls/example.png", bytes: 1234, mediaType: "image/png", kind: "screenshot", runId: "run-saturday" });

const api = await createApi({ storage, port: 0, segment: { resume: async () => ({ ok: true }) } });
api.recordHandoff({ jobId: "run-saturday-borders", viewerUrl: "https://app.steel.dev/sessions/sess-2", wall: "captcha", generation: 2, state: "awaiting_human" });
const base = `http://localhost:${api.port}`;
const out = path.join("fixtures", "api"); mkdirSync(out, { recursive: true });
const routes: Array<[string, string, string, unknown?]> = [
  ["health", "GET", "/health"], ["run", "GET", "/runs/run-saturday"], ["run-events", "GET", "/runs/run-saturday/events?format=json"],
  ["handoffs", "GET", "/handoffs"], ["job-takeover", "POST", "/jobs/run-saturday-borders/takeover", {}], ["job-viewer", "GET", "/jobs/run-saturday-borders/viewer"],
  ["coverage", "GET", "/runs/run-saturday/coverage"], ["borders", "GET", "/runs/run-saturday/borders"], ["prices", "GET", "/runs/run-saturday/prices"],
  ["matrix", "GET", "/runs/run-saturday/matrix"], ["diff", "GET", "/runs/run-saturday/diff?from=run-friday"], ["finding", "GET", "/findings/finding-sla"],
  ["artifact-meta", "GET", "/artifacts/artifact-1?meta=1"], ["account-setup-503", "POST", "/account-setups", { competitor: "ornn", url: "https://app.ornn.com/login", indicator: "Dashboard" }],
  ["runs-post-503", "POST", "/runs", { competitor: "ornn", url: "https://ornn.com", pages: ["/regulatory"], jobs: ["surface", "benchmark", "reveal"] }],
  ["job-resume", "POST", "/jobs/run-saturday-borders/resume", { generation: 2 }], ["run-cancel", "POST", "/runs/run-saturday/cancel", {}],
];
for (const [name, method, p, body] of routes) {
  const r = await fetch(base + p, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: body === undefined ? {} : { "content-type": "application/json" } });
  const json = await r.json();
  writeFileSync(path.join(out, `${name}.json`), JSON.stringify({ request: { method, path: p, body }, status: r.status, response: json }, null, 2));
  console.log(`${name}: ${method} ${p} -> ${r.status}`);
}
await api.close(); storage.close();

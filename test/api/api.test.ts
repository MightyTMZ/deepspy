// A14 API contract on fixtures (no Steel or Claude key), A15 SSE reconnect, A16 spend, A17 evidence drawer,
// plus the human-in-the-loop forwarding. In-memory SQLite, fake segment, fake launcher.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Storage } from "@periscope/knowledge";
import type { Observation, HandoffEvent } from "@periscope/contracts";
import { createApi, type Api } from "../../src/api/server.js";
import { StorageSink } from "../../src/integration/storage-sink.js";
import type { LaunchHandle, RunSpec } from "../../src/integration/launch-run.js";

let api: Api; let storage: Storage; let base: string;
const resumed: Array<[string, number]> = [];
const launched: RunSpec[] = [];

const obs = (runId: string, jobId: string, text: string, over: Partial<Observation> = {}): Observation => ({
  id: `${runId}/${jobId}/${text}`, runId, jobId, competitor: "acme", url: "https://acme.test/pricing",
  layer: "surface", source: "browser", kind: "text", text, vantage: { country: "CA", device: "desktop", authenticated: false },
  perception: "dom", capturedAt: new Date().toISOString(), ...over,
});

async function seed(runId: string) {
  const sink = new StorageSink({ storage, runId, category: "demo", capUsd: 12, jobHints: () => ({ purpose: "reveal", competitor: "acme", url: "https://acme.test/pricing" }) });
  await sink.write({ type: "job_state", data: { jobId: `${runId}-job`, state: "running" } });
  await sink.write({ type: "observation", data: obs(runId, `${runId}-job`, "Starter $12 per month") });
  await sink.write({ type: "observation", data: obs(runId, `${runId}-job`, "Team $24 per month", { layer: "hidden", missedByFetch: true, revealedBy: { action: "toggle", label: "Annual" }, screenshotPath: "C:/nowhere/shot.png", viewerUrl: "https://viewer.test/s1", steelSessionId: "s1" }) });
  await sink.write({ type: "observation", data: obs(runId, `${runId}-job`, "12,99 € / Monat", { layer: "borders", vantage: { country: "DE", device: "desktop", authenticated: false } }) });
  await sink.write({ type: "observation", data: obs(runId, `${runId}-job`, "$13.99 / month", { layer: "borders", vantage: { country: "CA", device: "desktop", authenticated: false } }) });
  await sink.write({ type: "counter", data: { competitor: "acme", url: "https://acme.test/pricing", missed: 1 } });
  await sink.write({ type: "receipt", data: { jobId: `${runId}-job`, step: 1, action: "extract", before: "sha-a", after: "sha-b", ok: true, tokensIn: 1, tokensOut: 1, usd: 0.25 } });
  await sink.write({ type: "handoff", data: { jobId: `${runId}-job`, viewerUrl: "https://viewer.test/s1", wall: "captcha", generation: 1, state: "awaiting_human" } });
  await sink.write({ type: "run_done", data: { runId } });
}

const get = async (p: string, init?: RequestInit) => { const r = await fetch(base + p, init); return { status: r.status, body: await r.json() as Record<string, unknown> }; };
const post = (p: string, body: unknown, headers: Record<string, string> = {}) => get(p, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", ...headers } });

beforeAll(async () => {
  storage = Storage.open({ path: ":memory:" }); storage.migrate();
  await seed("r1"); await seed("r2");
  storage.createFinding({ id: "f1", runId: "r2", competitor: "acme", kind: "feature", title: "Annual discount", status: "observed", value: "Team $24", observationIds: ["r2/r2-job/Team $24 per month", "r2/r2-job/Starter $12 per month"] });
  const fakeLaunch = (spec: RunSpec): LaunchHandle => {
    launched.push(spec);
    const done = (async () => { storage.createJob({ id: `${spec.runId}-j1`, runId: spec.runId, purpose: "surface", competitor: spec.competitor, url: spec.url, state: "completed" }); storage.setRunStatus(spec.runId, "completed"); return { completedJobs: [], failedJobs: [] }; })();
    return { runId: spec.runId, coordinator: {} as never, done, cancel: async () => { storage.setRunStatus(spec.runId, "cancelled", "test"); } };
  };
  api = await createApi({ storage, port: 0, segment: { resume: async (jobId, generation) => { resumed.push([jobId, generation]); return { ok: true }; } }, launch: fakeLaunch,
    liveSessions: (runId) => [{ sessionId: "s1", viewerUrl: "https://viewer.test/s1", playerUrl: "https://api.steel.dev/v1/sessions/s1/player", purpose: "reveal", vantage: { country: "CA", device: "desktop", authenticated: false }, deadlineAt: "2026-09-13T12:00:00Z", currentUrl: "https://acme.test/pricing", runId: "r1", competitor: "acme" }].filter((s) => !runId || s.runId === runId) });
  base = `http://localhost:${api.port}`;
});
afterAll(async () => { await api.close(); storage.close(); });

describe("A14 every endpoint answers with the documented shape without Steel or Claude", () => {
  it("health", async () => { const r = await get("/health"); expect(r.status).toBe(200); expect(r.body).toMatchObject({ ok: true, steel: false }); });
  it("GET /runs/:id with jobs, counts, counters and spend in dollars (A16)", async () => {
    const r = await get("/runs/r1"); expect(r.status).toBe(200);
    const run = r.body.run as Record<string, unknown>;
    expect(run.id).toBe("r1"); expect(run.spentUsd).toBe(0.25); expect(run.capUsd).toBe(12);
    expect((r.body.jobs as unknown[]).length).toBe(1);
    expect(r.body.counts).toMatchObject({ observations: 4, handoffs: 1 });
    expect(r.body.counters).toEqual([{ competitor: "acme", url: "https://acme.test/pricing", missed: 1 }]);
  });
  it("404 for an unknown run", async () => { expect((await get("/runs/nope")).status).toBe(404); });
  it("GET /runs lists newest first with counts; observations search filters by words and layer", async () => {
    const r = await get("/runs"); expect(r.status).toBe(200);
    const list = r.body.runs as Array<Record<string, unknown>>;
    expect(list.map((x) => x.id)).toEqual(expect.arrayContaining(["r1", "r2"]));
    expect(list.find((x) => x.id === "r1")).toMatchObject({ observations: 4, competitors: ["acme"], purposes: ["reveal"], spentUsd: 0.25 });
    const o = await get("/runs/r1/observations?q=team%20month&layer=hidden"); expect(o.status).toBe(200);
    expect(o.body.total).toBe(1);
    expect((o.body.observations as Array<{ text: string }>)[0].text).toBe("Team $24 per month");
    expect((await get("/runs/r1/observations?missedByFetch=1")).body.total).toBe(1);
  });
  it("coverage", async () => {
    const r = await get("/runs/r1/coverage"); expect(r.status).toBe(200);
    expect(r.body.totals).toMatchObject({ surface: 1, hidden: 1, missedByFetch: 1 });
    expect((r.body.pages as Array<Record<string, unknown>>)[0].counter).toBe(1);
  });
  it("borders grid flags the country price difference", async () => {
    const r = await get("/runs/r1/borders"); expect(r.status).toBe(200);
    const g = (r.body.grids as Array<Record<string, unknown>>)[0];
    expect(g.differsByCountry).toBe(true);
    expect((g.countries as Array<{ country: string; prices: string[] }>).map((c) => c.country)).toEqual(["CA", "DE"]);
  });
  it("prices parse decimal, currency and period (A12)", async () => {
    const r = await get("/runs/r1/prices"); expect(r.status).toBe(200);
    const rows = r.body.rows as Array<Record<string, unknown>>;
    expect(rows.find((x) => x.text === "12,99 € / Monat")).toMatchObject({ amount: "12.99", currency: "EUR", period: "month", country: "DE" });
    expect(rows.find((x) => x.text === "$13.99 / month")).toMatchObject({ amount: "13.99", currency: "USD", period: "month" });
    expect(rows.every((x) => typeof x.observationId === "string")).toBe(true);
  });
  it("matrix lists feature findings with evidence ids", async () => {
    const r = await get("/runs/r2/matrix"); expect(r.status).toBe(200);
    expect((r.body.rows as Array<Record<string, unknown>>)[0]).toMatchObject({ feature: "Annual discount", status: "observed" });
    expect((await get("/runs/r1/matrix")).body.note).toMatch(/model key/);
  });
  it("diff needs ?from and compares two runs (A13 shape)", async () => {
    expect((await get("/runs/r2/diff")).status).toBe(400);
    const r = await get("/runs/r2/diff?from=r1"); expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ fromRunId: "r1", toRunId: "r2", added: [], removed: [], unchanged: 4 });
  });
  it("viewer url for a job comes from the pending handoff or the observations", async () => {
    const r = await get("/jobs/r1-job/viewer"); expect(r.status).toBe(200);
    expect(r.body.viewerUrl).toBe("https://viewer.test/s1");
  });
  it("account setup answers 503 with the documented shape when Steel is off", async () => {
    const r = await post("/account-setups", { competitor: "acme", url: "https://acme.test/login", indicator: "Inbox" });
    expect(r.status).toBe(503); expect(r.body.setup).toMatchObject({ competitor: "acme", state: "awaiting_login" });
    expect((await get("/accounts/acme%2Ftrial9/status")).status).toBe(404);
  });
});

describe("runs: create with idempotency, cancel", () => {
  it("POST /runs launches once per idempotency key and replays the same run id", async () => {
    const a = await post("/runs", { competitor: "acme", url: "https://acme.test", jobs: ["surface"] }, { "idempotency-key": "k1" });
    expect(a.status).toBe(202); const id = a.body.runId as string;
    const b = await post("/runs", { competitor: "acme", url: "https://acme.test", jobs: ["surface"] }, { "idempotency-key": "k1" });
    expect(b.status).toBe(200); expect(b.body.runId).toBe(id); expect(b.body.replayed).toBe(true);
    const c = await post("/runs", { competitor: "other", url: "https://acme.test" }, { "idempotency-key": "k1" });
    expect(c.status).toBe(409);
    expect(launched.filter((s) => s.runId === id)).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 20));
    expect(((await get(`/runs/${id}`)).body.run as Record<string, unknown>).status).toBe("completed");
  });
  it("400 without competitor and url; cancel marks the run", async () => {
    expect((await post("/runs", {})).status).toBe(400);
    const a = await post("/runs", { competitor: "acme", url: "https://acme.test", runId: "r-cancel" });
    expect(a.status).toBe(202);
    const c = await post("/runs/r-cancel/cancel", {}); expect(c.status).toBe(200);
  });
});

describe("A15 events stream with ordered ids and reconnect", () => {
  it("json form pages by ?after and never repeats or skips", async () => {
    const all = (await get("/runs/r1/events?format=json")).body.events as Array<{ eventId: number }>;
    expect(all.length).toBeGreaterThan(5);
    const ids = all.map((e) => e.eventId);
    expect([...ids].sort((x, y) => x - y)).toEqual(ids);
    const mid = ids[3];
    const rest = (await get(`/runs/r1/events?format=json&after=${mid}`)).body.events as Array<{ eventId: number }>;
    expect(rest.map((e) => e.eventId)).toEqual(ids.slice(4));
  });
  it("SSE replays from Last-Event-ID and ends on a terminal run", async () => {
    const all = (await get("/runs/r1/events?format=json")).body.events as Array<{ eventId: number }>;
    const from = all[2].eventId;
    const r = await fetch(`${base}/runs/r1/events`, { headers: { "last-event-id": String(from) } });
    expect(r.headers.get("content-type")).toBe("text/event-stream");
    const text = await r.text();
    const got = [...text.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
    expect(got).toEqual(all.slice(3).map((e) => e.eventId));
    expect(text).toMatch(/event: end/);
  });
});

describe("live sessions", () => {
  it("lists live Steel sessions with player urls, per run and overall", async () => {
    const all = await get("/sessions"); expect(all.status).toBe(200);
    expect((all.body.sessions as Array<Record<string, unknown>>)[0]).toMatchObject({ sessionId: "s1", runId: "r1", competitor: "acme", playerUrl: "https://api.steel.dev/v1/sessions/s1/player", currentUrl: "https://acme.test/pricing" });
    expect(((await get("/runs/r1/sessions")).body.sessions as unknown[]).length).toBe(1);
    expect(((await get("/runs/r2/sessions")).body.sessions as unknown[]).length).toBe(0);
  });
});

describe("human in the loop forwarding", () => {
  it("handoffs list, takeover and resume forward to the segment", async () => {
    const h: HandoffEvent = { jobId: "r1-job", viewerUrl: "https://viewer.test/s1", wall: "captcha", generation: 3, state: "awaiting_human" };
    api.recordHandoff(h);
    expect(((await get("/handoffs")).body.handoffs as unknown[]).length).toBe(1);
    const t = await post("/jobs/r1-job/takeover", {}); expect(t.status).toBe(200); expect(t.body.viewerUrl).toBe(h.viewerUrl);
    const r = await post("/jobs/r1-job/resume", {}); expect(r.status).toBe(200);
    expect(resumed.at(-1)).toEqual(["r1-job", 3]);
    expect(((await get("/handoffs")).body.handoffs as unknown[]).length).toBe(0);
    expect((await post("/jobs/none/takeover", {})).status).toBe(404);
  });
});

describe("A17 evidence drawer", () => {
  it("GET /findings/:id resolves every observation id and reports missing artifacts", async () => {
    const r = await get("/findings/f1"); expect(r.status).toBe(200);
    expect((r.body.observations as unknown[]).length).toBe(2);
    expect(r.body.unresolved).toBe(0);
    expect((r.body.artifacts as Array<Record<string, unknown>>)[0]).toMatchObject({ exists: false });
    expect((await get("/findings/zzz")).status).toBe(404);
    expect((await get("/artifacts/zzz")).status).toBe(404);
  });
});

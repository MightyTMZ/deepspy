// A10 extraction alignment and evidence, A11 status discipline, diff summary shape. Fake model, in-memory SQLite.
import { describe, it, expect } from "vitest";
import { Storage } from "@periscope/knowledge";
import type { Observation } from "@periscope/contracts";
import { StorageSink } from "../../src/integration/storage-sink.js";
import { extractFeatures, selectForExtraction, summarizeDiff, type Complete } from "../../src/intel/extract.js";

const TAX = ["Free trial", "Service level agreement", "Single sign-on"];
function fresh() { const s = Storage.open({ path: ":memory:" }); s.migrate(); return s; }
const obs = (runId: string, competitor: string, text: string, over: Partial<Observation> = {}): Observation => ({
  id: `${runId}/${competitor}/${text}`, runId, jobId: `${runId}-${competitor}`, competitor, url: `https://${competitor}.test/pricing`,
  layer: "hidden", source: "browser", kind: "text", text, vantage: { country: "CA", device: "desktop", authenticated: false },
  perception: "dom", revealedBy: { action: "click", label: "Legal" }, missedByFetch: true, capturedAt: new Date().toISOString(), ...over,
});
async function seed(storage: Storage, competitor: string) {
  const sink = new StorageSink({ storage, runId: "r1", jobHints: () => ({ purpose: "reveal", competitor }) });
  await sink.write({ type: "observation", data: obs("r1", competitor, "14-day free trial, no card") });
  await sink.write({ type: "observation", data: obs("r1", competitor, "Service Level Agreement", { kind: "document" }) });
  await sink.write({ type: "observation", data: obs("r1", competitor, "SSO", { layer: "surface", missedByFetch: false, revealedBy: undefined }) });
}

describe("extractFeatures", () => {
  it("A10: two competitors land in the same rows; every row carries evidence ids; rows without evidence are rejected", async () => {
    const storage = fresh(); await seed(storage, "acme"); await seed(storage, "beta");
    const fake: Complete = async ({ user }) => {
      const c = user.startsWith("Competitor: acme") ? "acme" : "beta";
      return { tokensIn: 10, tokensOut: 5, input: { rows: [
        { feature: "Free trial", status: "observed", value: "14 days", evidenceIds: [`r1/${c}/14-day free trial, no card`] },
        { feature: "service level agreement", status: "observed", value: null, evidenceIds: [`r1/${c}/Service Level Agreement`] },
        { feature: "Single sign-on", status: "observed", value: "SSO", evidenceIds: [] },            // no evidence: rejected
        { feature: "Blockchain", status: "observed", value: null, evidenceIds: [`r1/${c}/SSO`] },     // not in taxonomy: rejected
        { feature: "Free trial", status: "observed", value: "dup", evidenceIds: [`r1/${c}/SSO`] },   // duplicate: rejected
        { feature: "API access", status: "unknown", value: null, evidenceIds: [] },                   // unknown without evidence is allowed, not a finding
      ] } };
    };
    const a = await extractFeatures({ storage, runId: "r1", competitor: "acme", complete: fake, taxonomy: [...TAX, "API access"] });
    const b = await extractFeatures({ storage, runId: "r1", competitor: "beta", complete: fake, taxonomy: [...TAX, "API access"] });
    expect(a.rows.map((r) => r.feature)).toEqual(["Free trial", "Service level agreement", "API access"]);
    expect(b.rows.map((r) => r.feature)).toEqual(a.rows.map((r) => r.feature));
    expect(a.rejected).toBe(3);
    expect(a.findings).toHaveLength(2);
    expect(a.findings.every((f) => f.observationIds.length > 0 && f.kind === "feature")).toBe(true);
    expect(storage.getFindingsByRun("r1", "feature")).toHaveLength(4);
    // idempotent: a second extraction reuses the findings
    const again = await extractFeatures({ storage, runId: "r1", competitor: "acme", complete: fake, taxonomy: [...TAX, "API access"] });
    expect(storage.getFindingsByRun("r1", "feature")).toHaveLength(4);
    expect(again.findings.map((f) => f.id)).toEqual(a.findings.map((f) => f.id));
  });

  it("A11: nothing becomes verified_working; a bad status is rejected", async () => {
    const storage = fresh(); await seed(storage, "acme");
    const fake: Complete = async () => ({ tokensIn: 1, tokensOut: 1, input: { rows: [
      { feature: "Free trial", status: "verified_working", value: "x", evidenceIds: ["r1/acme/14-day free trial, no card"] },
      { feature: "Single sign-on", status: "observed", value: "SSO", evidenceIds: ["r1/acme/SSO"] },
    ] } });
    const r = await extractFeatures({ storage, runId: "r1", competitor: "acme", complete: fake, taxonomy: TAX });
    expect(r.rejected).toBe(1);
    expect(r.findings.map((f) => f.status)).toEqual(["observed"]);
  });

  it("selects hidden lines before surface and skips the fetch benchmark", () => {
    const rows = [obs("r", "a", "s", { layer: "surface" }), obs("r", "a", "b", { source: "benchmark_fetch" }), obs("r", "a", "h"), obs("r", "a", "h")];
    expect(selectForExtraction(rows).map((o) => o.text)).toEqual(["h", "s"]);
  });
});

describe("summarizeDiff", () => {
  it("returns at most five strings and a fixed sentence for an empty diff", async () => {
    const fake: Complete = async () => ({ tokensIn: 1, tokensOut: 1, input: { bullets: ["US price rose to $12.99", 2, "b", "c", "d", "e", "f"] } });
    const empty = await summarizeDiff({ fromRunId: "a", toRunId: "b", added: [], removed: [], priceChanges: [], unchanged: 3 }, fake);
    expect(empty.bullets).toEqual(["No change between the two runs."]);
    const some = await summarizeDiff({ fromRunId: "a", toRunId: "b", added: [{ url: "u", vantage: "US/desktop", layer: "surface", kind: "text", text: "$12.99 / month" }], removed: [], priceChanges: [], unchanged: 3 }, fake);
    expect(some.bullets).toHaveLength(5); expect(some.bullets[0]).toBe("US price rose to $12.99");
  });
});

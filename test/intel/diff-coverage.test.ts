// Pure intel math: run-to-run diff and per-page coverage.
import { describe, it, expect } from "vitest";
import type { Observation } from "@periscope/contracts";
import { diffRuns } from "../../src/intel/diff.js";
import { coverage } from "../../src/intel/coverage.js";

function obs(runId: string, url: string, text: string, over: Partial<Observation> = {}): Observation {
  return {
    id: `${runId}/${url}/${text}`, runId, jobId: "j", competitor: "x", url,
    layer: "surface", source: "browser", kind: "text", text, vantage: { country: "CA", device: "desktop", authenticated: false },
    perception: "dom", capturedAt: new Date().toISOString(), ...over,
  } as Observation;
}

describe("diffRuns", () => {
  it("reports added, removed and unchanged lines and singles out new prices", () => {
    const a = [obs("r1", "u/pricing", "Starter"), obs("r1", "u/pricing", "$12 per month"), obs("r1", "u/pricing", "Free trial 14 days")];
    const b = [obs("r2", "u/pricing", "Starter"), obs("r2", "u/pricing", "$15 per month"), obs("r2", "u/pricing", "Enterprise", { layer: "hidden", revealedBy: { action: "click", label: "Compare plans" } })];
    const d = diffRuns("r1", a, "r2", b);
    expect(d.unchanged).toBe(1);
    expect(d.added.map((l) => l.text)).toEqual(["$15 per month", "Enterprise"]);
    expect(d.removed.map((l) => l.text)).toEqual(["$12 per month", "Free trial 14 days"]);
    expect(d.priceChanges.map((l) => l.text)).toEqual(["$15 per month"]);
    expect(d.added[1].revealedBy).toBe("Compare plans");
  });

  it("ignores pages scanned in only one of the runs", () => {
    const a = [obs("r1", "u/a", "only in a")];
    const b = [obs("r2", "u/b", "only in b")];
    const d = diffRuns("r1", a, "r2", b);
    expect(d.added).toHaveLength(0);
    expect(d.removed).toHaveLength(0);
  });

  it("treats the same text from another vantage as a distinct line", () => {
    const a = [obs("r1", "u", "$10")];
    const b = [obs("r2", "u", "$10"), obs("r2", "u", "$10", { vantage: { country: "DE", device: "desktop", authenticated: false } })];
    const d = diffRuns("r1", a, "r2", b);
    expect(d.added).toHaveLength(1);
    expect(d.added[0].vantage).toBe("DE/desktop");
  });
});

describe("coverage", () => {
  it("counts per page and orders pages by what fetch missed", () => {
    const rows = [
      obs("r", "u/home", "Welcome"),
      obs("r", "u/legal", "Legal"),
      obs("r", "u/legal", "SLA", { layer: "hidden", missedByFetch: true, revealedBy: { action: "click", label: "Legal" } }),
      obs("r", "u/legal", "https://u/terms.docx", { layer: "hidden", kind: "document", missedByFetch: true, revealedBy: { action: "click", label: "Legal" } }),
      obs("r", "u/legal", "Legal", { vantage: { country: "US", device: "mobile", authenticated: true } }),
      obs("other", "u/legal", "ignored"),
    ];
    const c = coverage("r", rows);
    expect(c.pages[0].url).toBe("u/legal");
    expect(c.pages[0]).toMatchObject({ surface: 2, hidden: 2, missedByFetch: 2, documents: 1, byAction: { Legal: 2 } });
    expect(c.pages[0].vantages).toEqual(["CA/desktop", "US/mobile"]);
    expect(c.totals).toEqual({ surface: 3, hidden: 2, missedByFetch: 2, documents: 1, authenticated: 1 });
  });
});

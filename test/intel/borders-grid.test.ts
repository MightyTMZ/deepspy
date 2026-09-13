// Pure grid math: which vantage saw which line, and whether prices differ by country or device.
import { describe, it, expect } from "vitest";
import type { Observation } from "@periscope/contracts";
import { bordersGrid } from "../../src/intel/borders-grid.js";

function obs(country: string, device: "desktop" | "mobile", text: string): Observation {
  return {
    id: `${country}/${device}/${text}`, runId: "r", jobId: "j", competitor: "x", url: "https://x.test/pricing",
    layer: "borders", source: "browser", kind: "text", text, vantage: { country, device, authenticated: false },
    perception: "dom", capturedAt: new Date().toISOString(),
  } as Observation;
}

describe("bordersGrid", () => {
  it("separates shared lines from per-vantage lines and detects country price differences", () => {
    const rows = [
      obs("CA", "desktop", "Premium Individual"), obs("US", "desktop", "Premium Individual"),
      obs("CA", "desktop", "CA$11.99 / month"), obs("US", "desktop", "$11.99 / month"),
      obs("CA", "desktop", "Available only in Canada"),
    ];
    const g = bordersGrid("https://x.test/pricing", rows);
    expect(g.shared).toBe(1);
    expect(g.differsByCountry).toBe(true);
    expect(g.differsByDevice).toBe(false);
    const ca = g.vantages.find((v) => v.key === "CA/desktop")!;
    expect(ca.unique).toEqual(expect.arrayContaining(["CA$11.99 / month", "Available only in Canada"]));
    expect(ca.prices).toEqual(["CA$11.99 / month"]);
    expect(g.countries.find((c) => c.country === "CA")?.uniqueToCountry).toContain("Available only in Canada");
  });

  it("recognises European price formats", () => {
    const rows = [obs("DE", "desktop", "10,99 € / Monat"), obs("DE", "desktop", "5,99 EUR pro Monat"), obs("US", "desktop", "$10.99 / month")];
    const g = bordersGrid("https://x.test/pricing", rows);
    expect(g.countries.find((c) => c.country === "DE")?.prices).toHaveLength(2);
    expect(g.differsByCountry).toBe(true);
  });

  it("flags device differences when mobile shows a price desktop does not", () => {
    const rows = [obs("US", "desktop", "$9 per month"), obs("US", "mobile", "$9 per month"), obs("US", "mobile", "$4.99 per month app-only")];
    const g = bordersGrid("https://x.test/pricing", rows);
    expect(g.differsByDevice).toBe(true);
    expect(g.differsByCountry).toBe(false);
  });

  it("ignores observations from other urls and layers", () => {
    const rows = [obs("US", "desktop", "a"), { ...obs("US", "desktop", "b"), url: "https://x.test/other" }, { ...obs("US", "desktop", "c"), layer: "hidden" as const }];
    const g = bordersGrid("https://x.test/pricing", rows);
    expect(g.vantages[0].total).toBe(1);
  });
});

// The fetch benchmark must store its sightings and compare visible text, not raw HTML (side-by-side beat).
import { describe, it, expect } from "vitest";
import { fetchBenchmark, htmlToText } from "../../src/benchmark.js";
import { MemorySink } from "../steel/helpers.js";

const HTML = `<html><head><title>T</title><style>p{color:red}</style><script>var x = "<p>nope</p>";</script></head>
<body><nav><a href="/">Home</a></nav><h1>Plans &amp; pricing</h1><p>Starter $12 per month</p><div style="display:none">Hidden to fetch too</div></body></html>`;

describe("fetch benchmark", () => {
  it("strips scripts, styles and tags", () => {
    const t = htmlToText(HTML);
    expect(t).not.toMatch(/color:red|var x|nope/);
    expect(t).toMatch(/Plans & pricing/);
    expect(t).toMatch(/Starter \$12 per month/);
  });

  it("writes one observation per block with source benchmark_fetch", async () => {
    const sink = new MemorySink();
    const res = await fetchBenchmark({
      url: "https://x.test/pricing", competitor: "x", runId: "r", jobId: "j", runStartedAt: new Date(Date.now() - 1000).toISOString(),
      vantage: { country: null, device: "desktop", authenticated: false }, sink,
      fetchFn: async () => ({ text: HTML, timestamp: new Date().toISOString() }),
    });
    expect(res.failed).toBe(false);
    const written = sink.ofType("observation").map((e) => e.data);
    expect(written.length).toBe(res.observations.length);
    expect(written.every((o) => o.source === "benchmark_fetch" && o.layer === "surface")).toBe(true);
    expect(written.map((o) => o.text)).toContain("Starter $12 per month");
  });
});

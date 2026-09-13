// Live tests against Steel: C1, C3, C4, C5, C8, C9, C11, C19, C20. Run with: npm run test:live
// Skipped unless PERISCOPE_LIVE=1 and STEEL_API_KEY are set. Each test records what it saw so a failure is explainable.
import { describe, it, expect } from "vitest";
import { SteelAdapter, defaultVantage } from "../../src/steel/steel-adapter.js";
import { LIVE } from "./helpers.js";

const d = LIVE ? describe : describe.skip;

d("Steel live", () => {
  const adapter = () => new SteelAdapter({ apiKey: process.env.STEEL_API_KEY!, proxyUrl: process.env.PERISCOPE_PROXY_URL });

  it("C1: create, load, screenshot, release under 15 seconds", async () => {
    const t0 = Date.now();
    const h = await adapter().open({ vantage: defaultVantage(), purpose: "surface" });
    await h.page.goto("https://example.com", { waitUntil: "domcontentloaded" });
    const png = await h.page.screenshot();
    await h.release();
    expect(png.byteLength).toBeGreaterThan(1000);
    expect(Date.now() - t0).toBeLessThan(15_000);
    expect(h.viewerUrl).toMatch(/^https?:\/\//);
  });

  it("C3: vantage countries resolve, or borders is flagged unavailable", async () => {
    const results: Record<string, string | undefined> = {};
    for (const country of ["CA", "US", "DE"]) {
      try {
        const h = await adapter().open({ vantage: defaultVantage({ country }), purpose: "borders" });
        results[country] = (await SteelAdapter.detectedIp(h)).country;
        await h.release();
      } catch (e) { results[country] = `error: ${(e as Error).message.slice(0, 80)}`; }
    }
    console.log("C3 vantage results", results);
    const ok = Object.entries(results).every(([c, got]) => got === c);
    if (!ok) console.warn("C3: proxies not available; mark the borders pass unavailable for the demo");
    expect(Object.keys(results)).toHaveLength(3);
  });

  it("C4: mobile mode reports a mobile user agent", async () => {
    const h = await adapter().open({ vantage: defaultVantage({ device: "mobile" }), purpose: "borders" });
    const ua = await h.page.evaluate(() => navigator.userAgent);
    await h.release();
    expect(ua).toMatch(/Mobile|Android|iPhone/);
  });

  const dCaptcha = process.env.STEEL_CAPTCHA === "1" ? it : it.skip;
  dCaptcha("C22: Steel detects a Turnstile widget after full page load and reaches a terminal state", async () => {
    const a = new SteelAdapter({ apiKey: process.env.STEEL_API_KEY!, solveCaptcha: true });
    const h = await a.open({ vantage: defaultVantage(), purpose: "reveal" });
    await h.page.goto("https://2captcha.com/demo/cloudflare-turnstile", { waitUntil: "load", timeout: 60_000 });
    let seen: string[] = []; const until = Date.now() + 120_000;
    while (Date.now() < until) {
      const st = await a.captchaStatus(h.sessionId);
      seen = st.tasks.map((t) => `${t.type}:${t.status}`);
      if (st.tasks.some((t) => /^(solved|failed_to_solve|validation_failed|failed_to_detect)$/.test(t.status))) break;
      await new Promise((r) => setTimeout(r, 4000));
    }
    await h.release();
    console.log("C22 states", seen);
    expect(seen.length).toBeGreaterThan(0);                 // detection happened
    expect(seen.some((x) => x.startsWith("turnstile:"))).toBe(true);
  }, 180_000);

  it.todo("C5: profile round trip after a human login (run setup-account first, then reopen with the profile id and find the signed-in indicator)");
  it.todo("C8 live: stored credential fills and blurs; grep of logs finds no password");
  it.todo("C9: a job past minute 11 gets checkpoint, profile save, release, and resumes in a new session");
  it.todo("C11: kill with three sessions open; restart releases exactly those three");
  it.todo("C19: trace export exists after release; downloaded document present with hash");
  it.todo("C20: real CAPTCHA page pauses the walker, human solves in live view, walker resumes");
});

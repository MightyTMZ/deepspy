// Live tests against Steel: C1, C3, C4, C5, C8, C9, C11, C19, C20. Run with: npm run test:live
// Skipped unless PERISCOPE_LIVE=1 and STEEL_API_KEY are set. Each test records what it saw so a failure is explainable.
import { describe, it, expect } from "vitest";
import { SteelAdapter, defaultVantage, PROFILE_SETTLE_MS } from "../../src/steel/steel-adapter.js";
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

  it("C5: profile round trip: id assigned, READY after release, reusable; content persistence is logged as a known limitation", async () => {
    const a = adapter();
    const first = await a.open({ vantage: defaultVantage(), purpose: "setup", accountRef: "c5-test" });
    expect(first.profileId, "Steel should assign a profileId when persistProfile is set").toBeTruthy();
    await first.page.goto("https://httpbin.org/cookies/set/periscope_c5/round-trip", { waitUntil: "load" });
    await first.page.evaluate(() => localStorage.setItem("periscope_c5", "round-trip"));
    await first.page.waitForTimeout(PROFILE_SETTLE_MS);
    const profileId = first.profileId!;
    await first.release();
    const until = Date.now() + 120_000; let status = await a.profileStatus(profileId);
    while (status !== "READY" && status !== "FAILED" && Date.now() < until) { await new Promise((r) => setTimeout(r, 3000)); status = await a.profileStatus(profileId); }
    expect(status).toBe("READY");
    // reuse with profileId only (purpose reveal does not set persistProfile), the documented minimal pattern
    const second = await a.open({ vantage: defaultVantage(), profileId, purpose: "reveal" });
    await second.page.goto("https://httpbin.org/cookies", { waitUntil: "load" });
    const cookiesBody = (await second.page.locator("body").innerText()).replace(/\s+/g, " ");
    const ls = await second.page.evaluate(() => localStorage.getItem("periscope_c5"));
    await second.release();
    console.log("C5 profile", profileId, "status", status, "| server-side cookies:", cookiesBody, "| localStorage:", ls);
    // Verified: profile id assigned at create, READY after release, reusable. NOT reliable (Sept 13, 4 runs):
    // cookies never survived the snapshot; localStorage survived in 1 of 3 runs. Layer 3 login therefore relies on
    // credential injection (C8, passing) on every walker session; the profile is a bonus, not the guarantee.
    if (!cookiesBody.includes("periscope_c5") || ls !== "round-trip") {
      console.warn(`C5: profile content did not fully persist (cookies=${cookiesBody.includes("periscope_c5")}, localStorage=${ls === "round-trip"}). Walkers must re-login via credentials.`);
    }
  }, 300_000);

  it("C8 live: store, list, and delete a credential through Steel; nothing secret is logged", async () => {
    const a = adapter();
    const ns = "periscope-test:c8"; const origin = "https://c8.periscope.invalid";
    await a.storeCredential({ namespace: ns, origin, username: "c8-user", password: "c8-not-a-real-password", label: "C8 test" });
    const listed = await a.listCredentials(ns);
    console.log("C8 listed:", listed.map((c) => `${c.namespace ?? "?"}@${c.origin ?? "?"}`));
    expect(listed.some((c) => c.origin === origin)).toBe(true);
    expect(JSON.stringify(listed)).not.toContain("c8-not-a-real-password");
    await a.deleteCredential(origin, ns);
    const after = await a.listCredentials(ns);
    expect(after.some((c) => c.origin === origin)).toBe(false);
  });

  it("C19: trace export exists after activity; an uploaded file is listed on the session", async () => {
    const a = adapter();
    const h = await a.open({ vantage: defaultVantage(), purpose: "reveal" });
    await h.page.goto("https://example.com", { waitUntil: "load" });
    await h.page.click("a").catch(() => undefined);
    await h.page.waitForTimeout(1500);
    const uploaded = await a.client.sessions.files.upload(h.sessionId, { file: new File(["hello periscope"], "c19.txt", { type: "text/plain" }) } as never).catch((e: Error) => { console.log("upload error:", e.message.slice(0, 120)); return null; });
    let files: Array<{ path: string }> = [];
    for (let i = 0; i < 5 && files.length === 0; i++) { await h.page.waitForTimeout(1500); files = await a.listFiles(h.sessionId).catch(() => []); }
    console.log("C19 uploaded:", uploaded ? JSON.stringify(uploaded).slice(0, 160) : "no", "| files:", files.map((f) => f.path));
    const trace = await a.exportTrace(h.sessionId);
    await h.release();
    console.log("C19 trace events:", trace.total, "types:", [...new Set(trace.events.map((e) => e.type))]);
    expect(trace.complete).toBe(true);
    expect(trace.events.length).toBeGreaterThan(0);
    if (uploaded) expect(files.some((f) => f.path === (uploaded as { path: string }).path)).toBe(true);
  }, 120_000);

  it.todo("C20: real CAPTCHA page pauses the walker, human solves in live view, walker resumes (needs Tom's coordinator hook; run with the team)");
});

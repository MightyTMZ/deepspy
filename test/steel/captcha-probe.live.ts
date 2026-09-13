// Live probe: public CAPTCHA demo pages on Steel sessions with the solver on. Reports our classifier, the family check,
// Steel's task end state, and whether the widget actually passed. Run: STEEL_CAPTCHA=1 npx tsx apps/api/test/steel/captcha-probe.live.ts
import { SteelAdapter, defaultVantage } from "../../src/steel/steel-adapter.js";
import { classifyFromDom } from "../../src/steel/walls.js";
import { unsupportedCaptchaFamily } from "../../src/steel/captcha.js";

const targets: Array<[string, string, (p: import("playwright-core").Page) => Promise<string>]> = [
  ["Google reCAPTCHA v2 demo", "https://www.google.com/recaptcha/api2/demo", async (p) => {
    const tok = await p.evaluate(() => (document.querySelector('textarea[name="g-recaptcha-response"]') as HTMLTextAreaElement | null)?.value ?? "");
    const checked = await p.frameLocator('iframe[src*="recaptcha/api2/anchor"]').first().locator("#recaptcha-anchor").getAttribute("aria-checked").catch(() => "n/a");
    return tok ? `g-recaptcha-response token (${tok.length} chars), checkbox=${checked}` : `no token, checkbox=${checked}`;
  }],
  ["2captcha Turnstile demo", "https://2captcha.com/demo/cloudflare-turnstile", async (p) => {
    const v = await p.evaluate(() => Array.from(document.querySelectorAll('input,textarea')).map((e) => [(e as HTMLInputElement).name, (e as HTMLInputElement).value] as const).filter(([n, val]) => /turnstile|cf-/.test(n) && val).map(([n, val]) => `${n}=${val.length} chars`).join("; "));
    return v || "no token";
  }],
  ["nopecha hCaptcha demo", "https://nopecha.com/captcha/hcaptcha", async (p) => {
    const v = await p.locator('textarea[name="h-captcha-response"]').inputValue().catch(() => "");
    return v ? "token present" : "no token (expected: unsupported)";
  }],
];
const adapter = new SteelAdapter({ apiKey: process.env.STEEL_API_KEY!, solveCaptcha: process.env.STEEL_CAPTCHA === "1" });
const rows: string[] = [];
for (const [name, url, passed] of targets) {
  const t0 = Date.now();
  try {
    const h = await adapter.open({ vantage: defaultVantage(), purpose: "reveal" });
    await h.page.goto(url, { waitUntil: "load", timeout: 60_000 });
    await h.page.waitForTimeout(3000);
    const verdict = await classifyFromDom(h.page);
    const family = unsupportedCaptchaFamily(await h.page.content());
    let last = "no tasks"; const until = Date.now() + 120_000;
    while (Date.now() < until) {
      const st = await adapter.captchaStatus(h.sessionId);
      if (st.tasks.length) last = st.tasks.map((t) => `${t.type ?? "?"}:${t.status}`).join(", ") + (st.isSolvingCaptcha ? " (solving)" : "");
      if (st.tasks.some((t) => /^(solved|failed_to_solve|validation_failed|failed_to_detect)$/.test(t.status))) break;
      await new Promise((r) => setTimeout(r, 4000));
    }
    const widget = await passed(h.page);
    rows.push(`| ${name} | ${verdict.wall ?? "none"} | ${family ?? "steel-supported"} | ${last} | ${widget} | ${Math.round((Date.now() - t0) / 1000)} s |`);
    await h.release();
  } catch (e) { rows.push(`| ${name} | error | | ${(e as Error).message.slice(0, 80)} | | ${Math.round((Date.now() - t0) / 1000)} s |`); }
}
console.log("| Page | Our classifier | Family | Steel task state | Widget result | Time |\n|---|---|---|---|---|---|\n" + rows.join("\n"));

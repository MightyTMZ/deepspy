// C21: CAPTCHA walls go to Steel's solver first; a human is only called when Steel fails, times out, or cannot. Offline.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { HandoffController, type JobDriver } from "../../src/steel/handoff.js";
import { unsupportedCaptchaFamily, waitForSteelSolve, type CaptchaStatus } from "../../src/steel/captcha.js";
import { MemorySink, fakeHandle, fixtureUrl, localPage } from "./helpers.js";
import type { Browser, Page } from "playwright-core";
import type { WallDetected } from "@periscope/contracts";

let browser: Browser; let page: Page;
beforeAll(async () => { ({ browser, page } = await localPage()); });
afterAll(async () => { await browser.close(); });

const wall: WallDetected = { jobId: "job1", sessionId: "s1", wall: "captcha", screenshotPath: "x.png", generation: 0 };
function driver() {
  const calls: string[] = [];
  const d: JobDriver = { async pause(j) { calls.push(`pause:${j}`); }, discardPending(j) { calls.push(`discard:${j}`); }, resume(j) { calls.push(`resume:${j}`); }, async fail(j, s, r) { calls.push(`fail:${j}:${s}:${r}`); } };
  return { d, calls };
}
const status = (...seq: CaptchaStatus["tasks"][number]["status"][]) => {
  let i = 0;
  return async (): Promise<CaptchaStatus> => { const st = seq[Math.min(i++, seq.length - 1)]; return { isSolvingCaptcha: st === "solving" || st === "detected", tasks: [{ type: "recaptchaV2", status: st }] }; };
};

describe("C21 Steel-first CAPTCHA policy", () => {
  it("Steel solves it: no pause, no handoff, no notification", async () => {
    await page.goto(fixtureUrl("recaptcha-wall.html"));
    const { d, calls } = driver(); const sink = new MemorySink(); let notified = 0;
    const hc = new HandoffController(d, sink, { captchaStatus: status("detected", "solving", "solved"), captchaWaitMs: 5000, notify: async () => { notified++; } });
    const r = await hc.onWall(wall, fakeHandle(page));
    expect(r.state).toBe("solved_by_steel");
    expect(calls).toEqual([]); expect(notified).toBe(0); expect(hc.isPending("job1")).toBe(false);
    expect(sink.ofType("job_state").at(-1)?.data.reason).toBe("captcha:solved");
  });

  it("Steel fails: pause, handoff, notify", async () => {
    await page.goto(fixtureUrl("recaptcha-wall.html"));
    const { d, calls } = driver(); const sink = new MemorySink(); let notified = 0;
    const hc = new HandoffController(d, sink, { captchaStatus: status("detected", "solving", "failed_to_solve"), captchaWaitMs: 5000, notify: async () => { notified++; } });
    const r = await hc.onWall(wall, fakeHandle(page));
    expect(r.state).toBe("awaiting_human"); expect(calls[0]).toBe("pause:job1"); expect(notified).toBe(1);
    expect(sink.ofType("job_state").some((e) => e.data.reason === "captcha:failed:failed_to_solve")).toBe(true);
  });

  it("Steel times out: escalate to a human", async () => {
    await page.goto(fixtureUrl("recaptcha-wall.html"));
    const { d } = driver(); const sink = new MemorySink();
    const hc = new HandoffController(d, sink, { captchaStatus: status("detected", "solving"), captchaWaitMs: 300 });
    const r = await hc.onWall(wall, fakeHandle(page));
    expect(r.state).toBe("awaiting_human");
    expect(sink.ofType("job_state").some((e) => e.data.reason === "captcha:timeout")).toBe(true);
  });

  it("unsupported family (hCaptcha): escalate immediately without waiting", async () => {
    await page.goto(fixtureUrl("captcha-wall.html")); // fixture uses an h-captcha div
    const t0 = Date.now();
    const out = await waitForSteelSolve(status("solving"), () => page.content(), { timeoutMs: 10_000 });
    expect(out.outcome).toBe("not_supported"); expect(Date.now() - t0).toBeLessThan(2000);
    expect(unsupportedCaptchaFamily('<div class="g-recaptcha"></div>')).toBeNull();
    expect(unsupportedCaptchaFamily('<script src="https://js.hcaptcha.com/1/api.js">')).toBe("hcaptcha");
    expect(unsupportedCaptchaFamily('<a href="/demo/hcaptcha">hCaptcha demo</a>')).toBeNull(); // a mention is not a widget
  });
});

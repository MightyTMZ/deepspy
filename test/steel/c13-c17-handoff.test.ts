// C13 lock, C14 generation, C15 re-observation, C16 payment refusal, C17 human timer. Offline.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { HandoffController, type JobDriver } from "../../src/steel/handoff.js";
import { MemorySink, fakeHandle, fixtureUrl, localPage } from "./helpers.js";
import type { Browser, Page } from "playwright-core";
import type { HandoffEvent, WallDetected } from "@periscope/contracts";

let browser: Browser; let page: Page;
beforeAll(async () => { ({ browser, page } = await localPage()); });
afterAll(async () => { await browser.close(); });

function driver() {
  const calls: string[] = [];
  const d: JobDriver = {
    async pause(jobId) { calls.push(`pause:${jobId}`); },
    discardPending(jobId) { calls.push(`discard:${jobId}`); },
    resume(jobId) { calls.push(`resume:${jobId}`); },
    async fail(jobId, state, reason) { calls.push(`fail:${jobId}:${state}:${reason}`); },
  };
  return { d, calls };
}

const wall = (kind: WallDetected["wall"]): WallDetected => ({ jobId: "job1", sessionId: "sess-test", wall: kind, screenshotPath: "x.png", generation: 0 });

describe("handoff controller", () => {
  it("C13: pauses, discards pending, sets awaiting_human, emits handoff before any resume", async () => {
    await page.goto(fixtureUrl("captcha-wall.html"));
    const { d, calls } = driver(); const sink = new MemorySink();
    const hc = new HandoffController(d, sink);
    const evt = (await hc.onWall(wall("captcha"), fakeHandle(page))) as HandoffEvent;
    expect(calls.slice(0, 2)).toEqual(["pause:job1", "discard:job1"]);
    expect(evt.state).toBe("awaiting_human");
    expect(sink.ofType("job_state")[0].data.state).toBe("awaiting_human");
    expect(hc.isPending("job1")).toBe(true);
    expect(calls).not.toContain("resume:job1");
  });

  it("C14: a stale generation is refused, the right one resumes", async () => {
    await page.goto(fixtureUrl("captcha-wall.html"));
    const { d, calls } = driver(); const sink = new MemorySink();
    const hc = new HandoffController(d, sink);
    const evt = (await hc.onWall(wall("captcha"), fakeHandle(page))) as HandoffEvent;
    expect((await hc.resume("job1", evt.generation - 1)).ok).toBe(false);
    expect((await hc.resume("job1", evt.generation)).ok).toBe(true);
    expect(calls).toContain("resume:job1");
    expect(sink.ofType("handoff").at(-1)?.data.state).toBe("resumed");
  });

  it("C15: after a login wall, resume verifies the signed-in indicator", async () => {
    await page.goto(fixtureUrl("login-wall.html"));
    const { d } = driver(); const sink = new MemorySink();
    const hc = new HandoffController(d, sink, { signedInIndicator: async () => "Workspace settings" });
    const evt = (await hc.onWall(wall("login"), fakeHandle(page))) as HandoffEvent;
    expect((await hc.resume("job1", evt.generation)).ok).toBe(false); // still on the login page
    await page.goto(fixtureUrl("settings-page.html"));               // human logged in
    expect((await hc.resume("job1", evt.generation)).ok).toBe(true);
  });

  it("C16: resume is refused while a payment field is visible", async () => {
    await page.goto(fixtureUrl("payment-wall.html"));
    const { d } = driver(); const sink = new MemorySink();
    const hc = new HandoffController(d, sink);
    const evt = (await hc.onWall(wall("payment"), fakeHandle(page))) as HandoffEvent;
    expect((await hc.resume("job1", evt.generation)).ok).toBe(false);
    await page.goto(fixtureUrl("settings-page.html"));
    expect((await hc.resume("job1", evt.generation)).ok).toBe(true);
  });

  it("C17: the human timer ends the job as partial", async () => {
    await page.goto(fixtureUrl("captcha-wall.html"));
    const { d, calls } = driver(); const sink = new MemorySink();
    const hc = new HandoffController(d, sink, { humanTimeoutMs: 300 });
    await hc.onWall(wall("captcha"), fakeHandle(page));
    await new Promise((r) => setTimeout(r, 500)); // real timer; fake timers would stall Playwright
    expect(calls.some((c) => c.startsWith("fail:job1:partial"))).toBe(true);
    expect(sink.ofType("handoff").at(-1)?.data.state).toBe("abandoned");
  });
});

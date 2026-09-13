// Model-free walker on a fixture site: crawls same-origin links, records interior lines, skips blocked links
// (billing, log out), ignores files and external hosts, and stops at a login wall with a WallDetected.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Browser, Page } from "playwright-core";
import { walkDeterministic } from "../../src/walker-deterministic.js";
import { MemorySink, fakeHandle, fixtureUrl, localPage } from "../steel/helpers.js";
import path from "node:path";
import os from "node:os";

let browser: Browser; let page: Page;
beforeAll(async () => { ({ browser, page } = await localPage()); });
afterAll(async () => { await browser.close(); });

describe("walkDeterministic", () => {
  it("crawls, records, blocks, and hands off at the wall", async () => {
    const sink = new MemorySink();
    const res = await walkDeterministic({
      runId: "r", jobId: "j", competitor: "fixture", startUrl: fixtureUrl("site/index.html"), page, handle: fakeHandle(page), sink,
      wallScreenshotDir: path.join(os.tmpdir(), "periscope-test-walls"),
    });
    const obs = sink.ofType("observation").map((e) => e.data);
    const texts = obs.map((o) => o.text);
    expect(texts).toContain("Welcome back, trial user. 3 projects active.");
    expect(texts).toContain("Plan: Team, 25 seats. SSO: enabled. Data region: EU.");
    expect(texts.some((t) => /Card number ending/.test(t))).toBe(false);      // billing never visited
    expect(texts.some((t) => /logged out/i.test(t))).toBe(false);             // log out never visited
    expect(obs.filter((o) => o.kind === "link").map((o) => o.text).join(" ")).toMatch(/billing\.html.*logout\.html|logout\.html.*billing\.html/);
    expect(obs.every((o) => o.layer === "interior")).toBe(true);
    expect(res.stoppedReason).toBe("wall");
    expect(res.wallDetected?.wall).toBe("login");
    expect(res.wallDetected?.screenshotPath).toMatch(/\.png$/);
    expect(res.screens.size).toBe(2);
  }, 60_000);
});

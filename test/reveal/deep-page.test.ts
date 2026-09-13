// Offline tests for the remaining reveal strategies: B13 consent wall, B10 infinite scroll, B11 iframe, B28 injected instructions.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Browser, Page } from "playwright-core";
import { revealDeterministic } from "../../src/reveal-deterministic.js";
import { MemorySink, fakeHandle, fixtureUrl, localPage } from "../steel/helpers.js";

let browser: Browser; let page: Page;
let texts: string[] = []; let labels: string[] = []; let url = ""; let actions = 0;
beforeAll(async () => {
  ({ browser, page } = await localPage());
  url = fixtureUrl("deep-page.html");
  await page.goto(url, { waitUntil: "load" });
  const sink = new MemorySink();
  const res = await revealDeterministic({ runId: "r", jobId: "j", competitor: "fixture", url, surfaceBaseline: "We value your privacy Reject all Accept all", page, handle: fakeHandle(page), sink, maxActionsPerStrategy: 6 });
  texts = res.observations.map((o) => o.text);
  labels = res.observations.map((o) => o.revealedBy?.label ?? "");
  actions = res.actions;
}, 60_000);
afterAll(async () => { await browser.close(); });

describe("deterministic reveal: deep page", () => {
  it("B13 consent: the privacy-preserving button is clicked, the overlay is gone, Accept all is never clicked", async () => {
    expect(actions).toBeGreaterThanOrEqual(1);
    expect(await page.locator("#consent").isHidden()).toBe(true);
    expect(labels).not.toContain("Accept all");
  });
  it("B10 infinite scroll: items appended on scroll are captured", () => {
    expect(texts.some((t) => /enterprise SSO added/.test(t))).toBe(true);
  });
  it("B11 iframe: embedded text is captured and attributed to the iframe", () => {
    const i = texts.findIndex((t) => /Embedded pricing calculator/.test(t));
    expect(i).toBeGreaterThanOrEqual(0);
    expect(labels[i]).toMatch(/^iframe/);
  });
  it("B28 injection: instructions hidden in the page are data, never actions; the page never leaves the url", () => {
    expect(decodeURI(page.url())).toBe(decodeURI(url));
    expect(texts.some((t) => /checkout/.test(t))).toBe(false);
    expect(labels.some((l) => /buy now/i.test(l))).toBe(false);
  });
});

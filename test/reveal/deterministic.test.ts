// Offline tests for the deterministic reveal pass on fixture pages: B4 nav duplicates, B7 pricing toggle,
// B8 dropdown options, B9 hover tooltip, B12 documents behind a click, B14 URL-change guard, B20 blocklist.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Browser, Page } from "playwright-core";
import { revealDeterministic } from "../../src/reveal-deterministic.js";
import { MemorySink, fakeHandle, fixtureUrl, localPage } from "../steel/helpers.js";

let browser: Browser; let page: Page;
beforeAll(async () => { ({ browser, page } = await localPage()); });
afterAll(async () => { await browser.close(); });

async function run(fixture: string, surfaceBaseline: string) {
  const url = fixtureUrl(fixture);
  await page.goto(url, { waitUntil: "load" });
  const sink = new MemorySink();
  const res = await revealDeterministic({ runId: "r", jobId: "j", competitor: "fixture", url, surfaceBaseline, page, handle: fakeHandle(page), sink, maxActionsPerStrategy: 6 });
  return { res, sink, texts: res.observations.map((o) => o.text), obs: res.observations };
}

describe("deterministic reveal on fixtures", () => {
  it("B7 pricing toggle: both billing states captured, annual-only line flagged missed by fetch", async () => {
    const baseline = "Plans Monthly Annual Starter $12 per user per month Business $24 per user per month";
    const { obs, texts } = await run("pricing-toggle.html", baseline);
    expect(texts.some((t) => /billed annually/.test(t))).toBe(true);
    const annual = obs.find((o) => /priority support/.test(o.text));
    expect(annual?.missedByFetch).toBe(true);
    expect(annual?.revealedBy?.action).toBe("toggle");
  });

  it("B8 dropdown: every option recorded as kind option", async () => {
    const { obs } = await run("pricing-toggle.html", "");
    const options = obs.filter((o) => o.kind === "option").map((o) => o.text);
    expect(options).toEqual(expect.arrayContaining(["seats: 1 seat", "seats: 5 seats", "seats: 25 seats", "seats: Enterprise 100+ seats"]));
  });

  it("B9 hover: tooltip text captured", async () => {
    const { texts } = await run("pricing-toggle.html", "");
    expect(texts.some((t) => /1,000 automations/.test(t))).toBe(true);
  });

  it("B12 documents: a link that appears only after Show more is captured as a document", async () => {
    const { obs } = await run("pricing-toggle.html", "");
    const doc = obs.find((o) => o.kind === "document");
    expect(doc?.text).toMatch(/security-whitepaper\.pdf$/);
  });

  it("B14 URL guard: navigation links are recorded as links and the page is restored", async () => {
    const url = fixtureUrl("pricing-toggle.html");
    const { obs } = await run("pricing-toggle.html", "");
    expect(decodeURI(page.url())).toBe(decodeURI(url));
    // "Contact sales" is a navigation link, not a modal trigger, so it is never clicked; "Buy now" is blocklisted
    expect(obs.some((o) => o.kind === "link" && /checkout/.test(o.text))).toBe(false);
  });

  it("B20 blocklist: Buy now is never clicked", async () => {
    const { obs } = await run("pricing-toggle.html", "");
    expect(obs.some((o) => o.revealedBy?.label && /buy now/i.test(o.revealedBy.label))).toBe(false);
  });

  it("B4 nav duplicates: three nav layouts yield no duplicate observations; hidden tab content is found", async () => {
    const baseline = "Home About Welcome Overview Legal Overview text here.";
    const { obs, texts } = await run("nav-duplicates.html", baseline);
    expect(texts.filter((t) => t === "Home")).toHaveLength(0); // in baseline, never re-captured
    expect(texts).toEqual(expect.arrayContaining(["Service Level Agreement", "Terms of Service"]));
    expect(obs.filter((o) => o.kind === "document").map((o) => o.text).some((t) => /terms\.docx$/.test(t))).toBe(true);
    const ids = obs.map((o) => o.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("counter event equals the number of missedByFetch observations", async () => {
    const { res, sink } = await run("nav-duplicates.html", "Home About Welcome Overview Legal Overview text here.");
    const counter = sink.ofType("counter").at(-1)?.data.missed;
    expect(counter).toBe(res.missedByFetch);
    expect(res.missedByFetch).toBeGreaterThanOrEqual(3);
  });
});

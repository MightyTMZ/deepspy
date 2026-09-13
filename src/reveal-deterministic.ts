// Deterministic reveal pass: plain Playwright, no model calls. Runs first; Tom's Stagehand reveal is the fallback
// for layouts these rules do not recognise. Spec: docs/periscope-final-architecture.md, section 6.3.
//
// After every action the visible text is diffed against the baseline and everything captured so far; new blocks
// become observations with revealedBy set and missedByFetch computed against the surface baseline.
// URL-change guard: a control that navigates is recorded as a `link` and the page is restored.
// Blocklist: never clicks a control whose label matches fixtures/blocklist.json.

import { readFileSync } from "node:fs";
import type { Page, Locator } from "playwright-core";
import type { Observation, SessionHandle, EventSink } from "@periscope/contracts";
import { createObservation, markMissedByFetch } from "./utils/observation-factory.js";
import { normalizeText, splitBlocks } from "./utils/text.js";

/** Visible text as normalized lines. innerText preserves the line structure the diff needs. */
async function visibleLines(page: Page): Promise<string[]> {
  const raw = await page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
  return raw.split(/\r?\n/).map(normalizeText).filter((l) => l.length >= 3);
}

const CODE_LIKE = /\bvar\s|\bfunction\s*\(|=>|;\s*$|^\/\/|\{\s*$|\}\s*$|window\.|document\./;

export interface DeterministicRevealConfig {
  runId: string;
  jobId: string;
  competitor: string;
  url: string;
  surfaceBaseline: string;
  page: Page;
  handle: SessionHandle;
  sink: EventSink;
  maxActionsPerStrategy?: number;   // default 12
  blocklistPath?: string;           // default fixtures/blocklist.json
}

export interface DeterministicRevealResult {
  observations: Observation[];
  missedByFetch: number;
  actions: number;
  strategies: Record<string, number>;   // observations produced per strategy
}

interface Ctx {
  cfg: DeterministicRevealConfig;
  baseline: string;
  seen: Set<string>;
  observations: Observation[];
  actions: number;
  max: number;
  blocked: RegExp;
  strategies: Record<string, number>;
  apiUrls: Set<string>;
}

function loadBlocklist(path: string): RegExp {
  try {
    const j = JSON.parse(readFileSync(path, "utf8")) as { blockedClickLabels?: string[] };
    const labels = (j.blockedClickLabels ?? []).map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    return new RegExp(`\\b(${labels.join("|")})\\b`, "i");
  } catch {
    return /\b(pay|buy|delete|remove|send|invite|publish|upgrade|subscribe|confirm order|submit)\b/i;
  }
}

async function emit(ctx: Ctx, obs: Observation): Promise<void> {
  ctx.observations.push(obs);
  await ctx.cfg.sink.write({ type: "observation", data: obs });
}

async function capture(ctx: Ctx, strategy: string, revealedBy: Observation["revealedBy"]): Promise<number> {
  const lines = await visibleLines(ctx.cfg.page);
  const blocks: string[] = [];
  for (const line of lines) {
    if (ctx.seen.has(line)) continue;
    ctx.seen.add(line);
    blocks.push(line);
  }
  let n = 0;
  for (const block of blocks) {
    if (block.length < 3 || CODE_LIKE.test(block)) continue;
    let obs = createObservation({
      runId: ctx.cfg.runId, jobId: ctx.cfg.jobId, competitor: ctx.cfg.competitor, url: ctx.cfg.url,
      layer: "hidden", source: "browser", kind: "text", text: block, revealedBy,
      vantage: ctx.cfg.handle.vantage, perception: "dom", steelSessionId: ctx.cfg.handle.sessionId, viewerUrl: ctx.cfg.handle.viewerUrl,
    });
    obs = markMissedByFetch(obs, ctx.cfg.surfaceBaseline);
    await emit(ctx, obs);
    n++;
  }
  ctx.strategies[strategy] = (ctx.strategies[strategy] ?? 0) + n;
  await documents(ctx, revealedBy?.label);
  return n;
}

/** Click with the URL guard. Returns false if the click navigated (recorded as a link and restored). */
async function guardedClick(ctx: Ctx, target: Locator, label: string): Promise<boolean> {
  if (ctx.actions >= ctx.max * 12) return false;
  if (ctx.blocked.test(label)) return false;
  const page = ctx.cfg.page;
  const before = page.url();
  try {
    await target.click({ timeout: 4000 });
  } catch {
    return false;
  }
  ctx.actions++;
  await page.waitForTimeout(400);
  const after = page.url();
  if (after !== before) {
    const obs = createObservation({
      runId: ctx.cfg.runId, jobId: ctx.cfg.jobId, competitor: ctx.cfg.competitor, url: ctx.cfg.url,
      layer: "hidden", source: "browser", kind: "link", text: after, revealedBy: { action: "click", label },
      vantage: ctx.cfg.handle.vantage, perception: "dom", steelSessionId: ctx.cfg.handle.sessionId,
    });
    await emit(ctx, obs);
    await page.goto(before, { waitUntil: "domcontentloaded" }).catch(() => undefined);
    await page.waitForTimeout(500);
    return false;
  }
  return true;
}

async function labelOf(l: Locator): Promise<string> {
  const t = (await l.innerText().catch(() => "")) || (await l.getAttribute("aria-label").catch(() => "")) || "";
  return normalizeText(t).slice(0, 80);
}

/* ---------------- strategies ---------------- */

async function consentWalls(ctx: Ctx): Promise<void> {
  const page = ctx.cfg.page;
  const decline = page.locator("button, a, [role=button]").filter({ hasText: /reject|decline|necessary only|essential only|only necessary|deny/i }).first();
  if (await decline.count()) {
    const label = await labelOf(decline);
    await guardedClick(ctx, decline, label);
    await capture(ctx, "consent", { action: "click", label });
  }
}

async function tabsAndAccordions(ctx: Ctx): Promise<void> {
  const page = ctx.cfg.page;
  const selectors = [
    "[role=tab]",
    "[aria-expanded=false]",
    "details:not([open]) > summary",
    "[data-tab], [data-toggle=tab], .tab, .tabs button, .accordion-header, .accordion button, .faq-question",
  ];
  // Text-only tab bars (e.g. Framer) expose no roles: fall back to short clickable headings that share a container.
  const candidates = page.locator(selectors.join(", "));
  let count = Math.min(await candidates.count(), ctx.max);
  for (let i = 0; i < count; i++) {
    const el = candidates.nth(i);
    const label = await labelOf(el);
    if (!label) continue;
    if (await guardedClick(ctx, el, label)) await capture(ctx, "tabs", { action: "click", label });
  }
  if (count === 0) {
    // Framer-style tabs: sibling short text nodes rendered as clickable divs/paragraphs with cursor:pointer.
    const clickable = page.locator("div, p, span, h5, h6").filter({ hasText: /^.{2,40}$/ });
    const total = Math.min(await clickable.count(), 400);
    const tried = new Set<string>();
    for (let i = 0; i < total && tried.size < ctx.max; i++) {
      const el = clickable.nth(i);
      const pointer = await el.evaluate((e) => getComputedStyle(e).cursor === "pointer" && e.children.length <= 2).catch(() => false);
      if (!pointer) continue;
      const label = await labelOf(el);
      if (!label || tried.has(label) || ctx.blocked.test(label)) continue;
      tried.add(label);
      if (await guardedClick(ctx, el, label)) await capture(ctx, "tabs", { action: "click", label });
    }
  }
}

async function selects(ctx: Ctx): Promise<void> {
  const page = ctx.cfg.page;
  const all = page.locator("select");
  const n = Math.min(await all.count(), ctx.max);
  for (let i = 0; i < n; i++) {
    const sel = all.nth(i);
    const label = (await sel.getAttribute("name").catch(() => null)) || (await sel.getAttribute("aria-label").catch(() => null)) || `select ${i + 1}`;
    const options = await sel.locator("option").allInnerTexts().catch(() => [] as string[]);
    for (const opt of options.map(normalizeText).filter(Boolean)) {
      let obs = createObservation({
        runId: ctx.cfg.runId, jobId: ctx.cfg.jobId, competitor: ctx.cfg.competitor, url: ctx.cfg.url,
        layer: "hidden", source: "browser", kind: "option", text: `${label}: ${opt}`, revealedBy: { action: "select", label },
        vantage: ctx.cfg.handle.vantage, perception: "dom", steelSessionId: ctx.cfg.handle.sessionId,
      });
      obs = markMissedByFetch(obs, ctx.cfg.surfaceBaseline);
      if (!ctx.seen.has(obs.text)) { ctx.seen.add(obs.text); await emit(ctx, obs); ctx.strategies.selects = (ctx.strategies.selects ?? 0) + 1; }
    }
  }
}

async function toggles(ctx: Ctx): Promise<void> {
  const page = ctx.cfg.page;
  const t = page.locator("[role=switch], input[type=checkbox]:visible, [role=radiogroup] [role=radio], label:has(input[type=radio])").filter({ hasNotText: /cookie/i });
  const n = Math.min(await t.count(), ctx.max);
  for (let i = 0; i < n; i++) {
    const el = t.nth(i);
    const label = (await labelOf(el)) || `toggle ${i + 1}`;
    if (await guardedClick(ctx, el, label)) {
      await capture(ctx, "toggles", { action: "toggle", label });
      await guardedClick(ctx, el, label); // restore
    }
  }
  // Text toggles like "Monthly | Annual" rendered as buttons
  const period = page.locator("button, [role=button], a").filter({ hasText: /^(annual(ly)?|yearly|monthly|per year|per month)$/i });
  const pn = Math.min(await period.count(), 4);
  for (let i = 0; i < pn; i++) {
    const el = period.nth(i); const label = await labelOf(el);
    if (await guardedClick(ctx, el, label)) await capture(ctx, "toggles", { action: "toggle", label });
  }
}

async function showMore(ctx: Ctx): Promise<void> {
  const page = ctx.cfg.page;
  for (let round = 0; round < ctx.max; round++) {
    const btn = page.locator("button, a, [role=button]").filter({ hasText: /^(show|load|see|view) (more|all)|more\b/i }).first();
    if (!(await btn.count())) break;
    const label = await labelOf(btn);
    if (!(await guardedClick(ctx, btn, label))) break;
    if ((await capture(ctx, "showMore", { action: "click", label })) === 0) break;
  }
  // infinite scroll: scroll until the document stops growing
  let last = -1;
  for (let i = 0; i < 30; i++) {
    const h = await page.evaluate(() => { window.scrollTo(0, document.body.scrollHeight); return document.body.scrollHeight; }).catch(() => 0);
    await page.waitForTimeout(500);
    if (h === last) break;
    last = h;
  }
  await capture(ctx, "scroll", { action: "scroll" });
  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => undefined);
}

async function hover(ctx: Ctx): Promise<void> {
  const page = ctx.cfg.page;
  const targets = page.locator("[aria-describedby], [title], [data-tooltip], [data-tip], .tooltip-trigger, button:has(svg[aria-label*=info i]), [aria-label*=info i]");
  const n = Math.min(await targets.count(), ctx.max);
  for (let i = 0; i < n; i++) {
    const el = targets.nth(i);
    const label = (await labelOf(el)) || (await el.getAttribute("title").catch(() => "")) || `hover ${i + 1}`;
    try { await el.hover({ timeout: 2000 }); ctx.actions++; } catch { continue; }
    await page.waitForTimeout(400);
    const before = ctx.observations.length;
    await capture(ctx, "hover", { action: "hover", label });
    if (ctx.observations.length > before) {
      const title = await el.getAttribute("title").catch(() => null);
      if (title) { /* title tooltips are also in the DOM; already captured as text if rendered */ }
    }
    await page.mouse.move(0, 0).catch(() => undefined);
  }
}

async function modals(ctx: Ctx): Promise<void> {
  const page = ctx.cfg.page;
  const triggers = page.locator("button, [role=button], a").filter({ hasText: /^(compare( plans)?|watch( demo| video)?|see demo|details|learn more|view details)$/i });
  const n = Math.min(await triggers.count(), ctx.max);
  for (let i = 0; i < n; i++) {
    const el = triggers.nth(i); const label = await labelOf(el);
    if (await guardedClick(ctx, el, label)) {
      await capture(ctx, "modals", { action: "click", label });
      await page.keyboard.press("Escape").catch(() => undefined);
      await page.waitForTimeout(300);
    }
  }
}

async function iframes(ctx: Ctx): Promise<void> {
  const page = ctx.cfg.page;
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    const src = frame.url();
    if (!src || src === "about:blank") continue;
    let text = "";
    try { text = await frame.locator("body").innerText({ timeout: 2000 }); } catch { /* cross-origin */ }
    if (text && normalizeText(text).length > 20) {
      const blocks = splitBlocks(text);
      for (const block of blocks) {
        if (ctx.seen.has(block) || block.length < 3 || CODE_LIKE.test(block)) continue;
        ctx.seen.add(block);
        let obs = createObservation({
          runId: ctx.cfg.runId, jobId: ctx.cfg.jobId, competitor: ctx.cfg.competitor, url: ctx.cfg.url,
          layer: "hidden", source: "browser", kind: "text", text: block, revealedBy: { action: "none", label: `iframe ${new URL(src).hostname}` },
          vantage: ctx.cfg.handle.vantage, perception: "dom", steelSessionId: ctx.cfg.handle.sessionId,
        });
        obs = markMissedByFetch(obs, ctx.cfg.surfaceBaseline);
        await emit(ctx, obs); ctx.strategies.iframes = (ctx.strategies.iframes ?? 0) + 1;
      }
    } else {
      const obs = createObservation({
        runId: ctx.cfg.runId, jobId: ctx.cfg.jobId, competitor: ctx.cfg.competitor, url: ctx.cfg.url,
        layer: "hidden", source: "browser", kind: "link", text: src, revealedBy: { action: "none", label: "iframe" },
        vantage: ctx.cfg.handle.vantage, perception: "dom", steelSessionId: ctx.cfg.handle.sessionId,
      });
      if (!ctx.seen.has(src)) { ctx.seen.add(src); await emit(ctx, obs); }
    }
  }
}

async function documents(ctx: Ctx, viaLabel?: string): Promise<void> {
  const page = ctx.cfg.page;
  const hrefs = await page.evaluate(() => Array.from(document.querySelectorAll("a[href]")).map((a) => (a as HTMLAnchorElement).href)).catch(() => [] as string[]);
  const docs = [...new Set(hrefs.filter((h) => /\.(pdf|docx?|xlsx?|pptx?|csv)(\?|#|$)/i.test(h)))];
  for (const href of docs) {
    if (ctx.seen.has(href)) continue;
    ctx.seen.add(href);
    let obs = createObservation({
      runId: ctx.cfg.runId, jobId: ctx.cfg.jobId, competitor: ctx.cfg.competitor, url: ctx.cfg.url,
      layer: "hidden", source: "browser", kind: "document", text: href, revealedBy: viaLabel ? { action: "click", label: viaLabel } : { action: "none", label: "document link" },
      vantage: ctx.cfg.handle.vantage, perception: "dom", steelSessionId: ctx.cfg.handle.sessionId,
    });
    obs = markMissedByFetch(obs, ctx.cfg.surfaceBaseline);
    await emit(ctx, obs); ctx.strategies.documents = (ctx.strategies.documents ?? 0) + 1;
  }
}

/** Hidden-API check: JSON responses the page loaded. A value shown as "Loading…" usually comes from one of these. */
async function hiddenApi(ctx: Ctx): Promise<void> {
  for (const u of ctx.apiUrls) {
    if (ctx.seen.has(u)) continue;
    ctx.seen.add(u);
    const obs = createObservation({
      runId: ctx.cfg.runId, jobId: ctx.cfg.jobId, competitor: ctx.cfg.competitor, url: ctx.cfg.url,
      layer: "hidden", source: "browser", kind: "link", text: u, revealedBy: { action: "none", label: "json api" },
      vantage: ctx.cfg.handle.vantage, perception: "dom", steelSessionId: ctx.cfg.handle.sessionId,
    });
    await emit(ctx, obs); ctx.strategies.hiddenApi = (ctx.strategies.hiddenApi ?? 0) + 1;
  }
}

/* ---------------- orchestration ---------------- */

export async function revealDeterministic(cfg: DeterministicRevealConfig): Promise<DeterministicRevealResult> {
  const page = cfg.page;
  const apiUrls = new Set<string>();
  const onResponse = (r: { url(): string; headers(): Record<string, string> }) => {
    const ct = r.headers()["content-type"] ?? "";
    if (/application\/json/i.test(ct) && !/analytics|gtm|segment|sentry|firebase|hotjar/i.test(r.url())) apiUrls.add(r.url());
  };
  page.on("response", onResponse);

  if (page.url() !== cfg.url) await page.goto(cfg.url, { waitUntil: "load", timeout: 60_000 });
  await page.waitForTimeout(1200);

  const baselineLines = await visibleLines(page);
  const baseline = baselineLines.join("\n");
  const ctx: Ctx = {
    cfg, baseline, seen: new Set(baselineLines), observations: [], actions: 0,
    max: cfg.maxActionsPerStrategy ?? 12, blocked: loadBlocklist(cfg.blocklistPath ?? "fixtures/blocklist.json"),
    strategies: {}, apiUrls,
  };

  const strategies: Array<[string, (c: Ctx) => Promise<void>]> = [
    ["consent", consentWalls], ["tabs", tabsAndAccordions], ["selects", selects], ["toggles", toggles],
    ["showMore", showMore], ["hover", hover], ["modals", modals], ["iframes", iframes], ["documents", (c) => documents(c)], ["hiddenApi", hiddenApi],
  ];
  for (const [name, fn] of strategies) {
    try { await fn(ctx); } catch (err) { console.error(`deterministic reveal ${name} failed:`, (err as Error).message.slice(0, 120)); }
  }
  page.off("response", onResponse);

  const missed = ctx.observations.filter((o) => o.missedByFetch).length;
  await cfg.sink.write({ type: "counter", data: { competitor: cfg.competitor, url: cfg.url, missed } });
  return { observations: ctx.observations, missedByFetch: missed, actions: ctx.actions, strategies: ctx.strategies };
}

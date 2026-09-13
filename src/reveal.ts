import type { Stagehand } from "@browserbasehq/stagehand";
import type { Page } from "playwright-core";
import type {
  Observation,
  SessionHandle,
  WallDetected,
  EventSink,
} from "@periscope/contracts";
import { perceive, extractVisibleText } from "./perception.js";
import { Policy } from "./policy.js";
import { Meter } from "./meter.js";
import {
  createObservation,
  markMissedByFetch,
} from "./utils/observation-factory.js";
import { diffText, normalizeText } from "./utils/text.js";

export interface RevealResult {
  observations: Observation[];
  wallDetected?: WallDetected;
}

export interface RevealConfig {
  runId: string;
  jobId: string;
  competitor: string;
  url: string;
  surfaceBaseline: string;
  stagehand: Stagehand;
  page: Page;
  handle: SessionHandle;
  meter: Meter;
  policy: Policy;
  sink: EventSink;
}

interface RevealContext {
  config: RevealConfig;
  baseline: string;
  seen: Set<string>;
  observations: Observation[];
  step: number;
}

// --- URL-change guard ---

async function withUrlGuard(
  ctx: RevealContext,
  fn: () => Promise<void>,
): Promise<{ urlChanged: boolean; newUrl?: string }> {
  const originalUrl = ctx.config.page.url();
  await fn();
  await ctx.config.page.waitForTimeout(300);
  const currentUrl = ctx.config.page.url();

  if (currentUrl !== originalUrl) {
    // Record as a link, restore original URL
    const obs = createObservation({
      runId: ctx.config.runId,
      jobId: ctx.config.jobId,
      competitor: ctx.config.competitor,
      url: ctx.config.url,
      layer: "hidden",
      source: "browser",
      kind: "link",
      text: currentUrl,
      revealedBy: { action: "click" },
      vantage: ctx.config.handle.vantage,
      perception: "dom",
      steelSessionId: ctx.config.handle.sessionId,
    });
    ctx.observations.push(obs);
    await ctx.config.sink.write({ type: "observation", data: obs });
    await ctx.config.page.goto(originalUrl, { waitUntil: "domcontentloaded" });
    return { urlChanged: true, newUrl: currentUrl };
  }
  return { urlChanged: false };
}

// --- Capture helper: diff and create observations ---

async function captureNewContent(
  ctx: RevealContext,
  revealedBy: Observation["revealedBy"],
  perception: Observation["perception"] = "dom",
): Promise<Observation[]> {
  const currentText = await extractVisibleText(ctx.config.page);
  const newBlocks = diffText(ctx.baseline, currentText, ctx.seen);
  const newObs: Observation[] = [];

  for (const block of newBlocks) {
    if (block.length < 3) continue;

    let obs = createObservation({
      runId: ctx.config.runId,
      jobId: ctx.config.jobId,
      competitor: ctx.config.competitor,
      url: ctx.config.url,
      layer: "hidden",
      source: "browser",
      kind: "text",
      text: block,
      revealedBy,
      vantage: ctx.config.handle.vantage,
      perception,
      steelSessionId: ctx.config.handle.sessionId,
      viewerUrl: ctx.config.handle.viewerUrl,
    });

    obs = markMissedByFetch(obs, ctx.config.surfaceBaseline);
    newObs.push(obs);
    ctx.observations.push(obs);
    await ctx.config.sink.write({ type: "observation", data: obs });
  }

  return newObs;
}

// --- Reveal strategies ---

async function revealTabs(ctx: RevealContext): Promise<void> {
  const { stagehand, page } = ctx.config;

  const tabsResult = await stagehand.observe(
    "Find all tab buttons, accordion headers, or elements with role=tab or aria-expanded=false",
  );

  for (const tab of tabsResult.data) {
    const violation = ctx.config.policy.check({
      method: "click",
      description: tab.description ?? "",
      selector: tab.selector ?? "",
    });
    if (violation) continue;

    const result = await withUrlGuard(ctx, async () => {
      await stagehand.act(`Click on "${tab.description}"`);
      await page.waitForTimeout(500);
    });
    if (result.urlChanged) continue;

    ctx.step++;
    await captureNewContent(ctx, {
      action: "click",
      label: tab.description,
      selector: tab.selector,
    });
  }
}

async function revealDropdowns(ctx: RevealContext): Promise<void> {
  const { stagehand, page } = ctx.config;

  const selects = await page.$$("select");
  for (const select of selects) {
    const options = await select.$$eval("option", (opts) =>
      opts.map((o) => ({ value: o.value, text: o.textContent?.trim() ?? "" })),
    );
    const originalValue = await select.inputValue();

    for (const option of options) {
      await select.selectOption(option.value);
      await page.waitForTimeout(300);

      ctx.step++;
      const obs = createObservation({
        runId: ctx.config.runId,
        jobId: ctx.config.jobId,
        competitor: ctx.config.competitor,
        url: ctx.config.url,
        layer: "hidden",
        source: "browser",
        kind: "option",
        text: option.text,
        revealedBy: { action: "select", label: option.text },
        vantage: ctx.config.handle.vantage,
        perception: "dom",
        steelSessionId: ctx.config.handle.sessionId,
      });
      const marked = markMissedByFetch(obs, ctx.config.surfaceBaseline);
      ctx.observations.push(marked);
      await ctx.config.sink.write({ type: "observation", data: marked });

      await captureNewContent(ctx, {
        action: "select",
        label: option.text,
      });
    }

    // Restore original selection
    await select.selectOption(originalValue);
  }
}

async function revealToggles(ctx: RevealContext): Promise<void> {
  const { stagehand, page } = ctx.config;

  const togglesResult = await stagehand.observe(
    "Find all toggle switches, radio groups, sliders, range inputs, and pricing toggles (monthly/annual)",
  );

  for (const toggle of togglesResult.data) {
    const violation = ctx.config.policy.check({
      method: "click",
      description: toggle.description ?? "",
      selector: toggle.selector ?? "",
    });
    if (violation) continue;

    const result = await withUrlGuard(ctx, async () => {
      await stagehand.act(`Click or toggle "${toggle.description}"`);
      await page.waitForTimeout(500);
    });
    if (result.urlChanged) continue;

    ctx.step++;
    await captureNewContent(ctx, {
      action: "toggle",
      label: toggle.description,
      selector: toggle.selector,
    });
  }
}

async function revealShowMore(ctx: RevealContext): Promise<void> {
  const { stagehand, page } = ctx.config;
  const MAX_ITERATIONS = 30;

  // "Show more" / "Load more" buttons
  const buttonsResult = await stagehand.observe(
    'Find buttons matching "show more", "load more", "see more", "view all", pagination next buttons',
  );

  for (const btn of buttonsResult.data) {
    const violation = ctx.config.policy.check({
      method: "click",
      description: btn.description ?? "",
      selector: btn.selector ?? "",
    });
    if (violation) continue;

    for (let i = 0; i < MAX_ITERATIONS; i++) {
      const prevHeight = await page.evaluate(() => document.body.scrollHeight);

      const result = await withUrlGuard(ctx, async () => {
        await stagehand.act(`Click "${btn.description}"`);
        await page.waitForTimeout(800);
      });
      if (result.urlChanged) break;

      ctx.step++;
      await captureNewContent(ctx, { action: "click", label: btn.description });

      const newHeight = await page.evaluate(() => document.body.scrollHeight);
      if (newHeight === prevHeight) break;
    }
  }

  // Infinite scroll: scroll to bottom until DOM stops growing
  let prevHeight = await page.evaluate(() => document.body.scrollHeight);
  for (let i = 0; i < MAX_ITERATIONS; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(1000);

    const newHeight = await page.evaluate(() => document.body.scrollHeight);
    if (newHeight === prevHeight) break;

    ctx.step++;
    await captureNewContent(ctx, { action: "scroll" });
    prevHeight = newHeight;
  }
}

async function revealHover(ctx: RevealContext): Promise<void> {
  const { stagehand, page } = ctx.config;

  const hoverTargetsResult = await stagehand.observe(
    "Find elements with aria-describedby, title attributes, info icons, tooltip triggers, and help icons",
  );

  for (const target of hoverTargetsResult.data) {
    if (!target.selector) continue;

    try {
      await page.hover(target.selector);
      await page.waitForTimeout(500);

      ctx.step++;
      const newObs = await captureNewContent(ctx, {
        action: "hover",
        label: target.description,
        selector: target.selector,
      });

      // Re-type tooltip observations
      for (const obs of newObs) {
        obs.kind = "tooltip";
      }

      // Move away to dismiss
      await page.mouse.move(0, 0);
      await page.waitForTimeout(300);
    } catch {
      // Element may not be hoverable
    }
  }
}

async function revealModals(ctx: RevealContext): Promise<void> {
  const { stagehand, page } = ctx.config;

  const modalTriggersResult = await stagehand.observe(
    'Find buttons matching "compare", "watch demo", "details", "learn more", "view details", "more info"',
  );

  for (const trigger of modalTriggersResult.data) {
    const violation = ctx.config.policy.check({
      method: "click",
      description: trigger.description ?? "",
      selector: trigger.selector ?? "",
    });
    if (violation) continue;

    const result = await withUrlGuard(ctx, async () => {
      await stagehand.act(`Click "${trigger.description}"`);
      await page.waitForTimeout(800);
    });
    if (result.urlChanged) continue;

    ctx.step++;
    await captureNewContent(ctx, {
      action: "click",
      label: trigger.description,
    });

    // Close the modal
    try {
      await stagehand.act("Close the modal or dialog");
      await page.waitForTimeout(300);
    } catch {
      await page.keyboard.press("Escape");
      await page.waitForTimeout(300);
    }
  }
}

async function revealIframes(ctx: RevealContext): Promise<void> {
  const { page } = ctx.config;

  const iframeInfos = await page.$$eval("iframe", (frames) =>
    frames.map((f) => ({
      src: f.src,
      sameOrigin: f.src
        ? new URL(f.src, window.location.href).origin === window.location.origin
        : true,
    })),
  );

  for (const info of iframeInfos) {
    if (!info.src) continue;

    if (info.sameOrigin) {
      // Read same-origin iframe content
      try {
        const frame = page.frames().find((f) => f.url().includes(info.src));
        if (frame) {
          const text = await frame.evaluate(() => document.body?.innerText ?? "");
          if (text.length > 3) {
            const obs = createObservation({
              runId: ctx.config.runId,
              jobId: ctx.config.jobId,
              competitor: ctx.config.competitor,
              url: ctx.config.url,
              layer: "hidden",
              source: "browser",
              kind: "text",
              text,
              revealedBy: { action: "none" },
              vantage: ctx.config.handle.vantage,
              perception: "dom",
              steelSessionId: ctx.config.handle.sessionId,
            });
            const marked = markMissedByFetch(obs, ctx.config.surfaceBaseline);
            ctx.observations.push(marked);
            await ctx.config.sink.write({ type: "observation", data: marked });
          }
        }
      } catch {
        // Frame may not be accessible
      }
    } else {
      // Cross-origin: record as link
      const obs = createObservation({
        runId: ctx.config.runId,
        jobId: ctx.config.jobId,
        competitor: ctx.config.competitor,
        url: ctx.config.url,
        layer: "hidden",
        source: "browser",
        kind: "link",
        text: info.src,
        revealedBy: { action: "none" },
        vantage: ctx.config.handle.vantage,
        perception: "dom",
        steelSessionId: ctx.config.handle.sessionId,
      });
      ctx.observations.push(obs);
      await ctx.config.sink.write({ type: "observation", data: obs });
    }
  }
}

async function revealDocuments(ctx: RevealContext): Promise<void> {
  const { page } = ctx.config;

  const docLinks = await page.$$eval(
    'a[href$=".pdf"], a[href$=".docx"], a[href$=".xlsx"], a[href$=".doc"], a[href$=".xls"]',
    (links) =>
      links.map((a) => ({
        href: (a as HTMLAnchorElement).href,
        text: a.textContent?.trim() ?? "",
      })),
  );

  for (const doc of docLinks) {
    if (!doc.href) continue;

    const obs = createObservation({
      runId: ctx.config.runId,
      jobId: ctx.config.jobId,
      competitor: ctx.config.competitor,
      url: ctx.config.url,
      layer: "hidden",
      source: "browser",
      kind: "document",
      text: `${doc.text}: ${doc.href}`,
      revealedBy: { action: "none" },
      vantage: ctx.config.handle.vantage,
      perception: "dom",
      steelSessionId: ctx.config.handle.sessionId,
    });

    const marked = markMissedByFetch(obs, ctx.config.surfaceBaseline);
    ctx.observations.push(marked);
    await ctx.config.sink.write({ type: "observation", data: marked });
  }
}

async function revealCookieWalls(ctx: RevealContext): Promise<void> {
  const { stagehand, page } = ctx.config;

  // Look for consent/cookie dialogs
  const consentButtonsResult = await stagehand.observe(
    'Find cookie consent or GDPR dialog buttons, especially "reject", "decline", "necessary only", "manage preferences"',
  );
  const consentButtons = consentButtonsResult.data;

  if (consentButtons.length === 0) return;

  // Record the wall
  const wallObs = createObservation({
    runId: ctx.config.runId,
    jobId: ctx.config.jobId,
    competitor: ctx.config.competitor,
    url: ctx.config.url,
    layer: "hidden",
    source: "browser",
    kind: "text",
    text: "Cookie/consent wall detected",
    revealedBy: { action: "none" },
    vantage: ctx.config.handle.vantage,
    perception: "dom",
    steelSessionId: ctx.config.handle.sessionId,
  });
  ctx.observations.push(wallObs);
  await ctx.config.sink.write({ type: "observation", data: wallObs });

  // Try to decline non-essential
  const declineBtn = consentButtons.find(
    (b) =>
      /reject|decline|necessary|refuse/i.test(b.description ?? ""),
  );

  if (declineBtn) {
    await stagehand.act(`Click "${declineBtn.description}"`);
  } else if (consentButtons.length > 0) {
    // Accept if no decline option
    await stagehand.act(`Click "${consentButtons[0].description}"`);
  }

  await page.waitForTimeout(500);
  ctx.step++;
  await captureNewContent(ctx, { action: "click", label: "consent" });
}

async function revealSearch(ctx: RevealContext): Promise<void> {
  const { page } = ctx.config;
  const MAX_QUERIES = 26;

  const searchInputs = await page.$$('input[type="search"], input[placeholder*="search" i], input[aria-label*="search" i]');
  if (searchInputs.length === 0) return;

  const input = searchInputs[0];
  const alphabet = "abcdefghijklmnopqrstuvwxyz";

  for (let i = 0; i < Math.min(MAX_QUERIES, alphabet.length); i++) {
    const violation = ctx.config.policy.checkInput("search", alphabet[i]);
    if (violation) continue;

    await input.fill(alphabet[i]);
    await page.waitForTimeout(500);

    ctx.step++;
    await captureNewContent(ctx, {
      action: "click",
      label: `search: ${alphabet[i]}`,
    });
  }

  // Clear the search
  await input.fill("");
}

async function revealChatWidgets(ctx: RevealContext): Promise<void> {
  const { stagehand, page } = ctx.config;

  const launchersResult = await stagehand.observe(
    "Find Intercom, Zendesk, Crisp, or help center launcher buttons and chat widget triggers",
  );

  for (const launcher of launchersResult.data) {
    const violation = ctx.config.policy.check({
      method: "click",
      description: launcher.description ?? "",
      selector: launcher.selector ?? "",
    });
    if (violation) continue;

    const result = await withUrlGuard(ctx, async () => {
      await stagehand.act(`Click "${launcher.description}"`);
      await page.waitForTimeout(800);
    });
    if (result.urlChanged) continue;

    ctx.step++;
    await captureNewContent(ctx, {
      action: "click",
      label: launcher.description,
    });

    // Try to walk the article list
    const articlesResult = await stagehand.observe(
      "Find help articles, FAQ items, or knowledge base links in the widget",
    );
    for (const article of articlesResult.data.slice(0, 10)) {
      await stagehand.act(`Click "${article.description}"`);
      await page.waitForTimeout(500);
      ctx.step++;
      await captureNewContent(ctx, {
        action: "click",
        label: article.description,
      });
    }

    // Close the widget
    try {
      await stagehand.act("Close the chat widget or help panel");
    } catch {
      await page.keyboard.press("Escape");
    }
  }
}

async function revealImageContent(ctx: RevealContext): Promise<void> {
  const { page } = ctx.config;

  // Look for images that might contain pricing tables, charts, diagrams
  const images = await page.$$eval("img", (imgs) =>
    imgs
      .filter((img) => {
        const alt = (img.alt ?? "").toLowerCase();
        const src = (img.src ?? "").toLowerCase();
        return (
          /pric|plan|chart|diagram|table|comparison/i.test(alt) ||
          /pric|plan|chart|diagram|table|comparison/i.test(src) ||
          (img.width > 300 && img.height > 200)
        );
      })
      .map((img) => ({ src: img.src, alt: img.alt ?? "" })),
  );

  if (images.length === 0) return;

  // Use screenshot rung to extract text from the page with these images
  const result = await perceive(
    ctx.config.stagehand,
    ctx.config.page,
    "Extract all text visible in images, including pricing tables, plan names, amounts, and chart data",
    ctx.config.meter,
    {
      forceRung: "screenshot",
      jobId: ctx.config.jobId,
      runId: ctx.config.runId,
      step: ctx.step,
    },
  );

  if (result.text) {
    const obs = createObservation({
      runId: ctx.config.runId,
      jobId: ctx.config.jobId,
      competitor: ctx.config.competitor,
      url: ctx.config.url,
      layer: "hidden",
      source: "browser",
      kind: "image_text",
      text: result.text,
      revealedBy: { action: "none" },
      vantage: ctx.config.handle.vantage,
      perception: "screenshot",
      screenshotPath: result.screenshotPath,
      steelSessionId: ctx.config.handle.sessionId,
    });

    const marked = markMissedByFetch(obs, ctx.config.surfaceBaseline);
    ctx.observations.push(marked);
    await ctx.config.sink.write({ type: "observation", data: marked });
  }
}

async function revealHiddenApi(ctx: RevealContext): Promise<void> {
  const { page } = ctx.config;

  // Look for "Loading..." or spinner elements that suggest async content
  const loadingElements = await page.$$eval(
    '[class*="loading" i], [class*="spinner" i], [aria-busy="true"]',
    (els) =>
      els.map((el) => ({
        text: el.textContent?.trim() ?? "",
        visible: getComputedStyle(el).display !== "none",
      })),
  );

  const loadingVisible = loadingElements.filter(
    (el) => el.visible && el.text.toLowerCase().includes("loading"),
  );
  if (loadingVisible.length === 0) return;

  // Wait for loading to resolve
  await page.waitForTimeout(3000);

  // Check if the content loaded and is also available via a public API
  // (We can detect XHR/fetch calls that provided the data)
  const apiCalls = await page.evaluate(() => {
    // Check performance entries for API-like requests
    const entries = performance.getEntriesByType("resource") as (PerformanceEntry & { initiatorType?: string; name: string })[];
    return entries
      .filter(
        (e) =>
          e.initiatorType === "xmlhttprequest" ||
          e.initiatorType === "fetch",
      )
      .map((e) => e.name);
  });

  for (const apiUrl of apiCalls) {
    if (/api|graphql|json|data/i.test(apiUrl)) {
      const obs = createObservation({
        runId: ctx.config.runId,
        jobId: ctx.config.jobId,
        competitor: ctx.config.competitor,
        url: ctx.config.url,
        layer: "hidden",
        source: "browser",
        kind: "link",
        text: `Public API endpoint: ${apiUrl}`,
        revealedBy: { action: "none" },
        vantage: ctx.config.handle.vantage,
        perception: "dom",
        steelSessionId: ctx.config.handle.sessionId,
      });
      ctx.observations.push(obs);
      await ctx.config.sink.write({ type: "observation", data: obs });
    }
  }
}

/**
 * Hidden content discovery. One Steel session per page.
 *
 * Captures baseline visible text, then runs each reveal strategy.
 * After each action, diffs visible text against baseline + all prior captures.
 * New blocks become Observations with revealedBy and missedByFetch set.
 *
 * URL-change guard: if a click changes the URL, record as "link" and restore.
 */
export async function reveal(config: RevealConfig): Promise<RevealResult> {
  const baseline = await extractVisibleText(config.page);
  const ctx: RevealContext = {
    config,
    baseline,
    seen: new Set(),
    observations: [],
    step: 0,
  };

  // Add baseline blocks to seen set so they're not re-captured
  const baselineBlocks = normalizeText(baseline).split(/\s{2,}/);
  for (const block of baselineBlocks) {
    ctx.seen.add(block);
  }

  // Run strategies in order
  const strategies = [
    revealCookieWalls,
    revealTabs,
    revealDropdowns,
    revealToggles,
    revealShowMore,
    revealHover,
    revealModals,
    revealIframes,
    revealDocuments,
    revealSearch,
    revealChatWidgets,
    revealImageContent,
    revealHiddenApi,
  ];

  for (const strategy of strategies) {
    try {
      await strategy(ctx);
    } catch (err) {
      // Log but don't fail the entire reveal pass
      console.error(
        `Reveal strategy ${strategy.name} failed:`,
        err,
      );
    }
  }

  return {
    observations: ctx.observations,
  };
}

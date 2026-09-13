import type { Stagehand } from "@browserbasehq/stagehand";
import type { Page } from "playwright-core";
import type {
  Observation,
  SessionHandle,
  WallDetected,
  EventSink,
} from "@periscope/contracts";
import { perceive, extractVisibleText, type Control } from "./perception.js";
import { Policy } from "./policy.js";
import { Meter, BudgetExceededError } from "./meter.js";
import { createObservation } from "./utils/observation-factory.js";
import { textHash, normalizeText } from "./utils/text.js";

export interface WalkerConfig {
  runId: string;
  jobId: string;
  competitor: string;
  startUrl: string;
  stagehand: Stagehand;
  page: Page;
  handle: SessionHandle;
  meter: Meter;
  policy: Policy;
  sink: EventSink;
}

export interface ScreenInfo {
  label: string;
  hash: string;
  observations: Observation[];
  parentHash?: string;
}

export interface WalkerResult {
  screens: Map<string, ScreenInfo>;
  totalSteps: number;
  wallDetected?: WallDetected;
  stoppedReason:
    | "screens_limit"
    | "steps_limit"
    | "empty_limit"
    | "deadline"
    | "budget"
    | "wall"
    | "complete";
}

const MAX_SCREENS = 40;
const MAX_STEPS = 120;
const MAX_EMPTY_STEPS = 8;
const CHECKPOINT_INTERVAL = 5;

// Patterns that indicate upgrade/billing screens (observe but don't operate)
const BILLING_PATTERNS =
  /upgrade|billing|payment|subscription|invoice|plan.*change/i;

// Patterns that indicate wall screens
const WALL_PATTERNS =
  /captcha|sign.?in|log.?in|verify|two.?factor|2fa|enter.*code/i;

/**
 * Rank controls: navigation and settings first, then other controls.
 * Billing/upgrade controls are deprioritized (observed, not operated).
 */
function rankControls(controls: Control[]): Control[] {
  return [...controls].sort((a, b) => {
    const aDesc = (a.description ?? "").toLowerCase();
    const bDesc = (b.description ?? "").toLowerCase();

    const aIsNav =
      /nav|menu|sidebar|settings|account|profile|dashboard|home/i.test(aDesc);
    const bIsNav =
      /nav|menu|sidebar|settings|account|profile|dashboard|home/i.test(bDesc);
    const aIsBilling = BILLING_PATTERNS.test(aDesc);
    const bIsBilling = BILLING_PATTERNS.test(bDesc);

    if (aIsNav && !bIsNav) return -1;
    if (!aIsNav && bIsNav) return 1;
    if (aIsBilling && !bIsBilling) return 1;
    if (!aIsBilling && bIsBilling) return -1;
    return 0;
  });
}

/**
 * Check if the current page looks like a wall (login, captcha, etc).
 */
async function detectWall(
  page: Page,
): Promise<WallDetected["wall"] | null> {
  const text = await extractVisibleText(page);
  const lower = text.toLowerCase();

  if (/captcha|recaptcha|hcaptcha|verify.*human/i.test(lower)) return "captcha";
  if (/sign.?in|log.?in|enter.*email.*password/i.test(lower)) return "login";
  if (/two.?factor|2fa|authenticator|verification.*code/i.test(lower))
    return "2fa";
  if (/enter.*code.*email|check.*inbox/i.test(lower)) return "email_code";
  if (/consent|cookie.*policy|gdpr/i.test(lower)) return "consent";

  // Check for password fields
  const hasPasswordField = await page
    .$('[type="password"]')
    .then((el) => !!el);
  if (hasPasswordField) return "login";

  return null;
}

/**
 * Label a screen using Stagehand extract.
 */
async function labelScreen(
  stagehand: Stagehand,
  page: Page,
): Promise<string> {
  try {
    const result = await stagehand.extract(
      "What is this screen? Provide a short 2-5 word label describing this page/view (e.g., 'Dashboard Overview', 'User Settings', 'API Keys Management')",
    );
    return (result as any).data?.extraction ?? "Unknown Screen";
  } catch {
    // Fallback: use page title
    const title = await page.title();
    return title || "Unknown Screen";
  }
}

/**
 * Authenticated interior exploration.
 *
 * Loop: perceive -> choose action from frontier -> validate policy -> act ->
 * wait for state change -> perceive again -> label screen -> hash -> add to map ->
 * checkpoint every 5 steps.
 *
 * Stops: 40 screens, 120 steps, 8 consecutive empty steps,
 *   session deadline, dollar cap, or wall.
 */
export async function walk(config: WalkerConfig): Promise<WalkerResult> {
  const screens = new Map<string, ScreenInfo>();
  const visitedHashes = new Set<string>();
  const visitedSelectors = new Set<string>();
  let totalSteps = 0;
  let consecutiveEmpty = 0;
  let wallDetected: WallDetected | undefined;
  let currentScreenHash: string | undefined;

  // Navigate to start URL
  await config.page.goto(config.startUrl, { waitUntil: "domcontentloaded" });
  await config.page.waitForTimeout(1000);

  // Check for wall on initial load
  const initialWall = await detectWall(config.page);
  if (initialWall) {
    const screenshotPath = `/tmp/periscope-wall-${Date.now()}.png`;
    const { writeFileSync } = await import("node:fs");
    writeFileSync(screenshotPath, await config.page.screenshot({ type: "png" }));

    wallDetected = {
      jobId: config.jobId,
      sessionId: config.handle.sessionId,
      wall: initialWall,
      screenshotPath,
      generation: 0,
    };
    await config.sink.write({
      type: "handoff",
      data: {
        jobId: config.jobId,
        viewerUrl: config.handle.viewerUrl,
        wall: initialWall,
        generation: 0,
        state: "awaiting_human",
      },
    });
    return { screens, totalSteps: 0, wallDetected, stoppedReason: "wall" };
  }

  // Capture initial screen
  const initialText = await extractVisibleText(config.page);
  const initialHash = textHash(initialText);
  visitedHashes.add(initialHash);
  const initialLabel = await labelScreen(config.stagehand, config.page);

  const initialObs = createObservation({
    runId: config.runId,
    jobId: config.jobId,
    competitor: config.competitor,
    url: config.page.url(),
    layer: "interior",
    source: "browser",
    kind: "screen",
    text: `[${initialLabel}] ${initialText.slice(0, 500)}`,
    vantage: config.handle.vantage,
    perception: "dom",
    steelSessionId: config.handle.sessionId,
    viewerUrl: config.handle.viewerUrl,
  });
  await config.sink.write({ type: "observation", data: initialObs });

  screens.set(initialHash, {
    label: initialLabel,
    hash: initialHash,
    observations: [initialObs],
  });
  currentScreenHash = initialHash;

  // Main exploration loop
  while (true) {
    // Check stop conditions
    if (screens.size >= MAX_SCREENS) {
      return { screens, totalSteps, stoppedReason: "screens_limit" };
    }
    if (totalSteps >= MAX_STEPS) {
      return { screens, totalSteps, stoppedReason: "steps_limit" };
    }
    if (consecutiveEmpty >= MAX_EMPTY_STEPS) {
      return { screens, totalSteps, stoppedReason: "empty_limit" };
    }
    if (new Date() >= new Date(config.handle.deadlineAt)) {
      return { screens, totalSteps, stoppedReason: "deadline" };
    }
    if (!config.meter.canProceed(config.jobId)) {
      return { screens, totalSteps, stoppedReason: "budget" };
    }

    // Perceive current state
    let perception;
    try {
      perception = await perceive(
        config.stagehand,
        config.page,
        "Find all interactive controls: navigation links, menu items, buttons, tabs, settings, and clickable elements",
        config.meter,
        { jobId: config.jobId, runId: config.runId, step: totalSteps },
      );
    } catch (err) {
      if (err instanceof BudgetExceededError) {
        return { screens, totalSteps, stoppedReason: "budget" };
      }
      throw err;
    }

    // Filter to unvisited controls and rank them
    const unvisited = perception.controls.filter(
      (c) => !visitedSelectors.has(c.selector),
    );
    const ranked = rankControls(unvisited);

    if (ranked.length === 0) {
      consecutiveEmpty++;
      totalSteps++;
      continue;
    }

    // Pick the top control
    const target = ranked[0];
    visitedSelectors.add(target.selector);

    // Policy check
    const violation = config.policy.check({
      method: target.method,
      description: target.description,
      selector: target.selector,
      arguments: target.arguments,
    });
    if (violation) {
      totalSteps++;

      // Still observe billing/upgrade screens via perception, just don't operate
      if (BILLING_PATTERNS.test(target.description)) {
        const obs = createObservation({
          runId: config.runId,
          jobId: config.jobId,
          competitor: config.competitor,
          url: config.page.url(),
          layer: "interior",
          source: "browser",
          kind: "text",
          text: `[Blocked] ${target.description}: ${violation.rule}`,
          vantage: config.handle.vantage,
          perception: perception.rung,
          steelSessionId: config.handle.sessionId,
        });
        await config.sink.write({ type: "observation", data: obs });
      }
      continue;
    }

    // Record state before action
    const beforeText = await extractVisibleText(config.page);

    // Act
    try {
      await config.stagehand.act(`Click on "${target.description}"`);
      await config.page.waitForTimeout(800);
    } catch (err) {
      totalSteps++;
      consecutiveEmpty++;
      continue;
    }

    totalSteps++;

    // Record receipt
    const afterText = await extractVisibleText(config.page);
    try {
      const receipt = config.meter.recordCall({
        jobId: config.jobId,
        runId: config.runId,
        step: totalSteps,
        action: `click: ${target.description}`,
        target: target.selector,
        before: beforeText.slice(0, 200),
        after: afterText.slice(0, 200),
        tokensIn: perception.tokensUsed.in,
        tokensOut: perception.tokensUsed.out,
        ok: true,
      });
      await config.sink.write({ type: "receipt", data: receipt });
    } catch (err) {
      if (err instanceof BudgetExceededError) {
        return { screens, totalSteps, stoppedReason: "budget" };
      }
    }

    // Check for wall
    const wall = await detectWall(config.page);
    if (wall) {
      const screenshotPath = `/tmp/periscope-wall-${Date.now()}.png`;
      const { writeFileSync } = await import("node:fs");
      writeFileSync(
        screenshotPath,
        await config.page.screenshot({ type: "png" }),
      );

      wallDetected = {
        jobId: config.jobId,
        sessionId: config.handle.sessionId,
        wall,
        screenshotPath,
        generation: totalSteps,
      };
      await config.sink.write({
        type: "handoff",
        data: {
          jobId: config.jobId,
          viewerUrl: config.handle.viewerUrl,
          wall,
          generation: totalSteps,
          state: "awaiting_human",
        },
      });
      return { screens, totalSteps, wallDetected, stoppedReason: "wall" };
    }

    // Hash new screen
    const newHash = textHash(afterText);

    if (visitedHashes.has(newHash)) {
      consecutiveEmpty++;
    } else {
      consecutiveEmpty = 0;
      visitedHashes.add(newHash);

      const label = await labelScreen(config.stagehand, config.page);

      const screenObs = createObservation({
        runId: config.runId,
        jobId: config.jobId,
        competitor: config.competitor,
        url: config.page.url(),
        layer: "interior",
        source: "browser",
        kind: "screen",
        text: `[${label}] ${afterText.slice(0, 500)}`,
        vantage: config.handle.vantage,
        perception: perception.rung,
        steelSessionId: config.handle.sessionId,
        viewerUrl: config.handle.viewerUrl,
      });
      await config.sink.write({ type: "observation", data: screenObs });

      screens.set(newHash, {
        label,
        hash: newHash,
        observations: [screenObs],
        parentHash: currentScreenHash,
      });
      currentScreenHash = newHash;
    }

    // Checkpoint every N steps
    if (totalSteps % CHECKPOINT_INTERVAL === 0) {
      await config.handle.checkpoint({
        screens: Array.from(screens.entries()),
        totalSteps,
        visitedHashes: Array.from(visitedHashes),
        visitedSelectors: Array.from(visitedSelectors),
      });
    }
  }
}

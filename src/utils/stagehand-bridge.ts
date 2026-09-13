import { Stagehand, localBrowser } from "@browserbasehq/stagehand";
import type { Page } from "playwright-core";
import type { SessionHandle } from "@periscope/contracts";
import { stagehandExtensionId } from "../steel/stagehand-extension.js";
import { randomUUID } from "node:crypto";
import type { EventSink } from "@periscope/contracts";
import { Meter, BudgetExceededError } from "../meter.js";

interface Accounting { meter: Meter; sink: EventSink; jobId: string; runId: string }

export interface StagehandSession {
  stagehand: Stagehand;
  page: Page;
  close(): Promise<void>;
}

/**
 * Create a Stagehand v4 instance connected to a Steel session via CDP.
 */
export async function createStagehand(
  handle: SessionHandle,
  accounting?: Accounting,
): Promise<StagehandSession> {
  // Steel cannot load Stagehand's extension from a local path; the segment installs it into the session by id
  // (src/steel/stagehand-extension.ts) and Stagehand attaches to that id.
  const extensionId = stagehandExtensionId();
  if (!extensionId) throw new Error("Stagehand extension not installed on Steel; the segment uploads it when ANTHROPIC_API_KEY is set");
  const browser = await localBrowser.connect({
    cdpUrl: handle.cdpUrl,
    extensionId,
  });

  const stagehand = await Stagehand.create({
    browser,
    model: {
      // Team decision: Opus family. Stagehand 4.1.0 lists claude-opus-4-8 as its newest Opus; override with STAGEHAND_MODEL.
      modelName: (process.env.STAGEHAND_MODEL ?? "anthropic/claude-opus-4-8") as "anthropic/claude-opus-4-8",
      apiKey: process.env.ANTHROPIC_API_KEY,
    },
  });

  // Use the playwright-core page from the SessionHandle for direct DOM operations. Stagehand's init can close or
  // replace a blank initial page, so re-resolve a live page from the same context after create.
  let page: Page = handle.page;
  const originalUrl = page.url();
  if (page.isClosed()) {
    const context = handle.page.context();
    const replacement = context.pages().find((p) => !p.isClosed() && p.url() === originalUrl);
    if (!replacement) { await stagehand.close(); throw new Error("Steel page closed during Stagehand attachment; no matching page remains"); }
    page = replacement;
  }
  handle.page = page;

  // Stagehand's active tab is independent of Playwright's page. Bind every operation
  // to the exact same tab; never let an extension/blank tab become the model's target.
  let step = 0;
  const bound = new Proxy(stagehand, {
    get(target, property) {
      if (!["act", "observe", "extract"].includes(String(property))) {
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return async (...args: unknown[]) => {
        if (page.isClosed()) throw new Error("Steel page closed before model operation");
        if (accounting && !accounting.meter.canProceed(accounting.jobId)) throw new BudgetExceededError("job", accounting.meter.jobSpend(accounting.jobId), 0);
        const marker = randomUUID();
        await page.evaluate((id) => { (window as unknown as Record<string, unknown>).__periscopePage = id; }, marker);
        const pages = await target.browser.context.pages();
        let exact: (typeof pages)[number] | undefined;
        for (const candidate of pages) {
          if (await candidate.evaluate(() => (window as unknown as Record<string, unknown>).__periscopePage).catch(() => null) === marker) { exact = candidate; break; }
        }
        if (!exact) throw new Error("Stagehand cannot locate the leased Steel page");
        const index = property === "extract" && args[1] && typeof args[1] === "object" && "parse" in args[1] ? 2 : 1;
        args[index] = { ...(args[index] as object ?? {}), page: exact, timeout: 30000 };
        const operation = Reflect.get(target, property, target) as (...args: unknown[]) => Promise<{ usage?: { inputTokens?: number; outputTokens?: number } }>;
        const result = await operation.apply(target, args);
        if (accounting && result.usage) {
          const receipt = accounting.meter.recordCall({ jobId: accounting.jobId, runId: accounting.runId, step: ++step, action: `stagehand.${String(property)}`, before: "", after: "Operation completed", tokensIn: result.usage.inputTokens ?? 0, tokensOut: result.usage.outputTokens ?? 0, ok: true });
          await accounting.sink.write({ type: "receipt", data: receipt });
        }
        return result;
      };
    },
  });

  return {
    stagehand: bound,
    page,
    async close() {
      await stagehand.close();
    },
  };
}

import { Stagehand, localBrowser } from "@browserbasehq/stagehand";
import type { Page } from "playwright-core";
import type { SessionHandle } from "@periscope/contracts";
import { stagehandExtensionId } from "../steel/stagehand-extension.js";

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

  // Use the playwright-core page from the SessionHandle for direct DOM operations
  const page = handle.page;

  return {
    stagehand,
    page,
    async close() {
      await stagehand.close();
    },
  };
}

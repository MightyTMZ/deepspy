// Test helpers for Fahad's segment. Fixture tests use a local Chromium; live tests need STEEL_API_KEY and PERISCOPE_LIVE=1.

import path from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import type { Event, EventSink, SessionHandle, Vantage } from "@periscope/contracts";

export const LIVE = process.env.PERISCOPE_LIVE === "1" && !!process.env.STEEL_API_KEY;

export function fixtureUrl(name: string): string {
  return "file:///" + path.resolve(process.cwd(), "fixtures", name).replace(/\\/g, "/");
}

export async function localPage(): Promise<{ browser: Browser; page: Page }> {
  // Requires a locally installed Chrome; set PERISCOPE_CHROME to override.
  const executablePath = process.env.PERISCOPE_CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
  const browser = await chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage();
  return { browser, page };
}

export class MemorySink implements EventSink {
  events: Event[] = [];
  async write(event: Event): Promise<void> { this.events.push(event); }
  ofType<T extends Event["type"]>(t: T): Extract<Event, { type: T }>[] {
    return this.events.filter((e): e is Extract<Event, { type: T }> => e.type === t);
  }
}

export function fakeHandle(page: Page, over: Partial<SessionHandle> = {}): SessionHandle {
  const vantage: Vantage = { country: "CA", device: "desktop", authenticated: false };
  return {
    sessionId: "sess-test", viewerUrl: "https://viewer.test/sess-test", cdpUrl: "wss://test.invalid", vantage, page,
    deadlineAt: new Date(Date.now() + 11 * 60_000).toISOString(),
    async release() {}, async checkpoint() {},
    ...over,
  };
}

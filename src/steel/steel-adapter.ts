// Owner: Fahad. Layer 1. The only file that talks to the Steel SDK directly.
// Spec: docs/periscope-final-architecture.md, section 7.1. Tests: C1, C3, C4, C8, C19, C22.
//
// Verified live on Sept 13: sessions.create accepts timeout, solveCaptcha, profileId, persistProfile,
// deviceConfig.device, useProxy.geolocation. CAPTCHA solving and managed proxies need a $10 paid balance
// on the Launch plan (403 otherwise). Verify any new option against docs.steel.dev before relying on it.

import Steel from "steel-sdk";
import { chromium } from "playwright-core";
import type { LeaseRequest, SessionHandle, Vantage } from "@periscope/contracts";

const SESSION_TIMEOUT_MS = 14 * 60 * 1000;   // free plan cap is 15 minutes
const AUTONOMOUS_CUTOFF_MS = 11 * 60 * 1000; // deadlineAt: work stops here, 3 minutes reserved for handoff and collection

export interface SteelAdapterOptions {
  apiKey: string;
  proxyUrl?: string;          // bring-your-own proxy when managed proxies are not unlocked
  solveCaptcha?: boolean;     // Steel's solver needs a $10 paid balance on Launch; default off. Set STEEL_CAPTCHA=1 to enable
  onCheckpoint?: (sessionId: string, state: unknown) => Promise<void>;
}

export class SteelAdapter {
  private readonly steel: Steel;

  constructor(private readonly opts: SteelAdapterOptions) {
    if (!opts.apiKey) throw new Error("STEEL_API_KEY is required");
    this.steel = new Steel({ steelAPIKey: opts.apiKey });
  }

  /** The underlying Steel client, for callers that need raw SDK access (Person B's surface pass). */
  get client(): Steel { return this.steel; }

  /** Create a session for a lease and attach Playwright over CDP. */
  async open(req: LeaseRequest): Promise<SessionHandle> {
    const createOpts: Record<string, unknown> = { timeout: SESSION_TIMEOUT_MS };
    if (this.opts.solveCaptcha ?? process.env.STEEL_CAPTCHA === "1") createOpts.solveCaptcha = true;
    if (req.profileId) createOpts.profileId = req.profileId;
    if (req.purpose === "setup" || req.purpose === "walker") createOpts.persistProfile = true;
    if (req.vantage.device === "mobile") createOpts.deviceConfig = { device: "mobile" };
    if (req.vantage.country) {
      createOpts.useProxy = this.opts.proxyUrl
        ? { url: this.opts.proxyUrl }
        : { geolocation: { country: req.vantage.country, ...(req.vantage.region ? { state: req.vantage.region } : {}) } };
    }
    // TODO(C8): attach credentials namespace when the lease carries an accountRef with stored credentials.

    const session = await this.steel.sessions.create(createOpts as never);
    const query = new URLSearchParams({ apiKey: this.opts.apiKey, sessionId: session.id });
    const cdpUrl = `wss://connect.steel.dev?${query.toString()}`; // never log this: it carries the API key
    const browser = await chromium.connectOverCDP(cdpUrl);
    const context = browser.contexts()[0];
    if (!context) throw new Error("Steel browser context unavailable");
    const page = context.pages()[0] ?? (await context.newPage());

    const deadlineAt = new Date(Date.now() + AUTONOMOUS_CUTOFF_MS).toISOString();
    const steel = this.steel;
    const onCheckpoint = this.opts.onCheckpoint;

    return {
      sessionId: session.id,
      viewerUrl: (session as { sessionViewerUrl?: string }).sessionViewerUrl ?? "",
      cdpUrl,
      vantage: req.vantage,
      profileId: req.profileId,
      page,
      deadlineAt,
      async checkpoint(state) {
        if (onCheckpoint) await onCheckpoint(session.id, state);
      },
      async release() {
        try { await browser.close(); } catch { /* already closed */ }
        await steel.sessions.release(session.id);
      },
    };
  }

  /**
   * Steel's CAPTCHA solver status for a session. Polled; Steel sends no events.
   * Live shape (Sept 13): an array of page states [{ pageId, url, isSolvingCaptcha, tasks: [{ type, status, ... }] }];
   * before any page is tracked it can be [] or { states: [] }. Detection attaches on full page load, so
   * navigate with waitUntil "load" before expecting tasks.
   */
  async captchaStatus(sessionId: string): Promise<{ isSolvingCaptcha: boolean; tasks: Array<{ type?: string; status: string }> }> {
    const raw = await (this.steel.sessions as unknown as { captchas: { status(id: string): Promise<unknown> } }).captchas.status(sessionId);
    type PageState = { isSolvingCaptcha?: boolean; tasks?: Array<{ type?: string; status: string }> };
    const pages: PageState[] = Array.isArray(raw)
      ? (raw as PageState[])
      : ((raw as { states?: PageState[]; pages?: PageState[] }).states ?? (raw as { pages?: PageState[] }).pages ?? []);
    return {
      isSolvingCaptcha: pages.some((pg) => Boolean(pg.isSolvingCaptcha)),
      tasks: pages.flatMap((pg) => pg.tasks ?? []),
    };
  }

  /** Ask Steel to (re)try solving every CAPTCHA it has detected on the session. */
  async triggerCaptchaSolve(sessionId: string): Promise<unknown> {
    return (this.steel.sessions as unknown as { captchas: { solve(id: string, body?: unknown): Promise<unknown> } }).captchas.solve(sessionId, {});
  }

  /** Agent trace export for a session; used as evidence. */
  async exportTrace(sessionId: string): Promise<unknown> {
    // TODO(C19): GET /v1/sessions/:id/agent-traces with time filters and hasMore paging; mark incomplete coverage explicitly.
    void sessionId;
    throw new Error("not implemented");
  }

  /** Files the browser saved during the session. */
  async listFiles(sessionId: string): Promise<unknown[]> {
    // TODO(C19): sessions.files.list(id) and download into the artifact directory with a hash.
    void sessionId;
    throw new Error("not implemented");
  }

  /** The IP the session exits from, for vantage verification (C3). */
  static async detectedIp(handle: SessionHandle): Promise<{ ip: string; country?: string }> {
    await handle.page.goto("https://ipinfo.io/json", { waitUntil: "domcontentloaded" });
    const text = await handle.page.locator("body").innerText();
    const json = JSON.parse(text) as { ip: string; country?: string };
    return { ip: json.ip, country: json.country };
  }
}

export function defaultVantage(overrides: Partial<Vantage> = {}): Vantage {
  return { country: null, device: "desktop", authenticated: false, ...overrides };
}

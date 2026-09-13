// Owner: Fahad. The one object Person B's coordinator needs from segment C.
//
// Usage in the coordinator:
//   const c = createSteelSegment({ sink });
//   new Coordinator({ ..., acquireSession: c.acquireSession, steel: c.steel });
//   // when a walker returns wallDetected, call c.onWall(wallDetected, handle) BEFORE releasing the handle,
//   // and only release once the returned promise says the job resumed or was abandoned.

import Steel from "steel-sdk";
import type { EventSink, LeaseRequest, SessionHandle, WallDetected } from "@periscope/contracts";
import { SteelAdapter } from "./steel-adapter.js";
import { SessionPool } from "./pool.js";
import { HandoffController, type JobDriver } from "./handoff.js";
import { Notifier } from "./notifier.js";
import { loadProfiles } from "./profiles.js";

export interface SteelSegmentOptions {
  sink: EventSink;
  driver?: JobDriver;            // the coordinator's pause/resume hooks; a no-op driver is used if absent
  apiKey?: string;               // defaults to STEEL_API_KEY
  solveCaptcha?: boolean;        // defaults to STEEL_CAPTCHA=1
  proxyUrl?: string;             // defaults to PERISCOPE_PROXY_URL
  webhookUrl?: string;           // defaults to PERISCOPE_WEBHOOK_URL
}

export interface SteelSegment {
  steel: Steel;
  adapter: SteelAdapter;
  pool: SessionPool;
  handoff: HandoffController;
  notifier: Notifier;
  acquireSession: (req: LeaseRequest) => Promise<SessionHandle>;
  onWall: (wall: WallDetected, handle: SessionHandle) => ReturnType<HandoffController["onWall"]>;
  resume: (jobId: string, generation: number) => ReturnType<HandoffController["resume"]>;
}

const noopDriver: JobDriver = {
  async pause() {}, discardPending() {}, resume() {}, async fail() {},
};

export function createSteelSegment(opts: SteelSegmentOptions): SteelSegment {
  const apiKey = opts.apiKey ?? process.env.STEEL_API_KEY ?? "";
  const adapter = new SteelAdapter({
    apiKey,
    proxyUrl: opts.proxyUrl ?? (process.env.PERISCOPE_PROXY_URL || undefined),
    solveCaptcha: opts.solveCaptcha ?? process.env.STEEL_CAPTCHA === "1",
  });
  const pool = new SessionPool(adapter, {
    homeCountryOf: async (profileId) => loadProfiles().find((p) => p.profileId === profileId)?.homeCountry ?? null,
    isProfileReady: async (profileId) => loadProfiles().find((p) => p.profileId === profileId)?.ready ?? true,
  });
  const notifier = new Notifier({ webhookUrl: opts.webhookUrl ?? (process.env.PERISCOPE_WEBHOOK_URL || undefined) });
  const handoff = new HandoffController(opts.driver ?? noopDriver, opts.sink, {
    notify: (evt, wall) => notifier.notify(evt, wall),
    captchaStatus: (sessionId) => adapter.captchaStatus(sessionId) as Promise<never>,
    signedInIndicator: async (jobId) => {
      void jobId; // TODO: look up the competitor's signed-in indicator from the profile record for this job
      return null;
    },
  });
  return {
    steel: adapter.client,
    adapter,
    pool,
    handoff,
    notifier,
    acquireSession: (req) => pool.lease(req),
    onWall: (wall, handle) => handoff.onWall(wall, handle),
    resume: async (jobId, generation) => {
      const r = await handoff.resume(jobId, generation);
      if (r.ok) notifier.stop(jobId);
      return r;
    },
  };
}

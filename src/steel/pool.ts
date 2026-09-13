// Owner: Fahad. The session pool. Spec: section 7.1. Tests: C2, C6, C7, C9, C10, C11.
//
// Rules: 10 slots, one lease per account, fair queue, deadline at minute 11, forced release at minute 14,
// reconciliation on startup releases only sessions this app created.

import type { LeaseRequest, SessionHandle } from "@periscope/contracts";
import type { SteelAdapter } from "./steel-adapter.js";

export interface PoolOptions {
  maxConcurrent?: number;          // default 10
  forcedReleaseMs?: number;        // default 14 minutes
  isProfileReady?: (profileId: string) => Promise<boolean>;
  homeCountryOf?: (profileId: string) => Promise<string | null>;
}

interface Waiter { req: LeaseRequest; resolve: (h: SessionHandle) => void; reject: (e: Error) => void; }

export class SessionPool {
  private active = new Map<string, { handle: SessionHandle; accountRef?: string; timer: NodeJS.Timeout }>();
  private accountLocks = new Set<string>();
  private queue: Waiter[] = [];
  private readonly max: number;
  private readonly forcedReleaseMs: number;

  constructor(private readonly adapter: SteelAdapter, private readonly opts: PoolOptions = {}) {
    this.max = opts.maxConcurrent ?? 10;
    this.forcedReleaseMs = opts.forcedReleaseMs ?? 14 * 60 * 1000;
  }

  /** Request a session. Resolves when a slot and, if needed, the account lock are free. */
  lease(req: LeaseRequest): Promise<SessionHandle> {
    return new Promise((resolve, reject) => {
      this.queue.push({ req, resolve, reject });
      void this.drain();
    });
  }

  activeCount(): number { return this.active.size; }
  queuedCount(): number { return this.queue.length; }

  /** Startup: release sessions this app created and did not close. Never call an organization-wide release. */
  async reconcile(ownedSessionIds: string[]): Promise<string[]> {
    // TODO(C11): for each owned id still live on Steel, release it and mark its job recoverable.
    return ownedSessionIds;
  }

  private async drain(): Promise<void> {
    if (this.active.size >= this.max) return;
    const idx = this.queue.findIndex((w) => !w.req.accountRef || !this.accountLocks.has(w.req.accountRef));
    if (idx === -1) return;
    const [waiter] = this.queue.splice(idx, 1);
    const { req } = waiter;
    try {
      await this.guardVantage(req);
      if (req.profileId && this.opts.isProfileReady && !(await this.opts.isProfileReady(req.profileId))) {
        throw new Error(`profile ${req.profileId} is not ready`);
      }
      if (req.accountRef) this.accountLocks.add(req.accountRef);
      const raw = await this.adapter.open(req);
      const timer = setTimeout(() => void this.forceRelease(raw.sessionId), this.forcedReleaseMs);
      const handle: SessionHandle = {
        ...raw,
        release: async () => {
          clearTimeout(timer);
          this.active.delete(raw.sessionId);
          if (req.accountRef) this.accountLocks.delete(req.accountRef);
          await raw.release();
          void this.drain();
        },
      };
      this.active.set(raw.sessionId, { handle, accountRef: req.accountRef, timer });
      waiter.resolve(handle);
    } catch (e) {
      if (req.accountRef) this.accountLocks.delete(req.accountRef);
      waiter.reject(e as Error);
    }
    void this.drain();
  }

  /** C7: a saved login may only be used from its home country. */
  private async guardVantage(req: LeaseRequest): Promise<void> {
    if (!req.profileId || !this.opts.homeCountryOf) return;
    const home = await this.opts.homeCountryOf(req.profileId);
    if (home && req.vantage.country && req.vantage.country !== home) {
      throw new Error(`profile ${req.profileId} is bound to ${home}; refusing vantage ${req.vantage.country}`);
    }
  }

  private async forceRelease(sessionId: string): Promise<void> {
    const entry = this.active.get(sessionId);
    if (!entry) return;
    await entry.handle.release();
  }
}

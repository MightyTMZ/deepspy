// Owner: Fahad. The session pool. Spec: section 7.1. Tests: C2, C6, C7, C9, C10, C11.
//
// Rules: 10 slots, one lease per account, fair queue, deadline at minute 11 with a checkpoint call,
// forced release at minute 14, reconciliation on startup releases only sessions this app created.

import fs from "node:fs";
import path from "node:path";
import type { LeaseRequest, SessionHandle } from "@periscope/contracts";
import type { SteelAdapter } from "./steel-adapter.js";

export interface PoolOptions {
  maxConcurrent?: number;          // default 10
  forcedReleaseMs?: number;        // default 14 minutes
  deadlineMs?: number;             // default 11 minutes: autonomous work must stop; checkpoint fires
  isProfileReady?: (profileId: string) => Promise<boolean>;
  homeCountryOf?: (profileId: string) => Promise<string | null>;
  /** Called at the deadline with whatever state the job last checkpointed; the session is released after. */
  onDeadline?: (sessionId: string, lastCheckpoint: unknown) => Promise<void>;
  /** Where owned session ids are journaled for crash reconciliation. Default PERISCOPE_DATA_DIR/sessions.local.json */
  journalPath?: string;
  /** For C11: list live session ids on the account and release one. Defaults to the adapter's methods. */
  liveSessionIds?: () => Promise<string[]>;
  releaseSession?: (id: string) => Promise<void>;
}

interface Waiter { req: LeaseRequest; resolve: (h: SessionHandle) => void; reject: (e: Error) => void; }
interface Active { handle: SessionHandle; accountRef?: string; forceTimer: NodeJS.Timeout; deadlineTimer: NodeJS.Timeout; lastCheckpoint: unknown; }

export class SessionPool {
  private active = new Map<string, Active>();
  private accountLocks = new Set<string>();
  private queue: Waiter[] = [];
  private readonly max: number;
  private readonly forcedReleaseMs: number;
  private readonly deadlineMs: number;
  private readonly journal: string;

  constructor(private readonly adapter: SteelAdapter, private readonly opts: PoolOptions = {}) {
    this.max = opts.maxConcurrent ?? 10;
    this.forcedReleaseMs = opts.forcedReleaseMs ?? 14 * 60 * 1000;
    this.deadlineMs = opts.deadlineMs ?? 11 * 60 * 1000;
    this.journal = opts.journalPath ?? path.join(process.env.PERISCOPE_DATA_DIR ?? "./data", "sessions.local.json");
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

  /**
   * C11. Startup: release sessions this app journaled as owned and that are still live on Steel.
   * Never calls an organization-wide release. Returns the ids it released, so jobs can be marked recoverable.
   */
  async reconcile(): Promise<string[]> {
    const owned = this.readJournal();
    if (owned.length === 0) return [];
    const live = new Set(await (this.opts.liveSessionIds ?? (() => this.adapter.liveSessionIds()))());
    const released: string[] = [];
    for (const id of owned) {
      if (!live.has(id)) continue;
      try { await (this.opts.releaseSession ?? ((x: string) => this.adapter.releaseSession(x)))(id); released.push(id); }
      catch { /* keep going; the forced timeout on Steel's side is the backstop */ }
    }
    this.writeJournal(owned.filter((id) => !released.includes(id) && live.has(id)));
    return released;
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
      const entry: Active = {
        handle: raw, accountRef: req.accountRef, lastCheckpoint: undefined,
        forceTimer: setTimeout(() => void this.forceRelease(raw.sessionId), this.forcedReleaseMs),
        deadlineTimer: setTimeout(() => void this.hitDeadline(raw.sessionId), this.deadlineMs),
      };
      const handle: SessionHandle = {
        ...raw,
        deadlineAt: new Date(Date.now() + this.deadlineMs).toISOString(),
        checkpoint: async (state) => { entry.lastCheckpoint = state; await raw.checkpoint(state); },
        release: async () => {
          clearTimeout(entry.forceTimer); clearTimeout(entry.deadlineTimer);
          this.active.delete(raw.sessionId);
          if (req.accountRef) this.accountLocks.delete(req.accountRef);
          this.writeJournal(this.readJournal().filter((id) => id !== raw.sessionId));
          await raw.release();
          void this.drain();
        },
      };
      entry.handle = handle;
      this.active.set(raw.sessionId, entry);
      this.writeJournal([...this.readJournal(), raw.sessionId]);
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

  /** C9: at the deadline, hand the last checkpoint to the coordinator, then release so the profile is saved. */
  private async hitDeadline(sessionId: string): Promise<void> {
    const entry = this.active.get(sessionId);
    if (!entry) return;
    try { if (this.opts.onDeadline) await this.opts.onDeadline(sessionId, entry.lastCheckpoint); } catch { /* reported by caller */ }
    await entry.handle.release();
  }

  private async forceRelease(sessionId: string): Promise<void> {
    const entry = this.active.get(sessionId);
    if (!entry) return;
    await entry.handle.release();
  }

  private readJournal(): string[] {
    try { return fs.existsSync(this.journal) ? (JSON.parse(fs.readFileSync(this.journal, "utf8")) as string[]) : []; } catch { return []; }
  }

  private writeJournal(ids: string[]): void {
    try { fs.mkdirSync(path.dirname(this.journal), { recursive: true }); fs.writeFileSync(this.journal, JSON.stringify([...new Set(ids)])); } catch { /* journal is best effort */ }
  }
}

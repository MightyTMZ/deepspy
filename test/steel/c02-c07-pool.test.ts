// C2 pool cap, C6 readiness, C7 home-country, C10 forced release. Offline with a fake adapter.
import { describe, it, expect, vi } from "vitest";
import { SessionPool } from "../../src/steel/pool.js";
import type { SteelAdapter } from "../../src/steel/steel-adapter.js";
import type { LeaseRequest, SessionHandle } from "@periscope/contracts";

function fakeAdapter() {
  let n = 0; const released: string[] = [];
  const adapter = {
    async open(req: LeaseRequest): Promise<SessionHandle> {
      const id = `s${++n}`;
      return { sessionId: id, viewerUrl: `v/${id}`, cdpUrl: `wss://test/${id}`, vantage: req.vantage, profileId: req.profileId, page: {} as never,
        deadlineAt: new Date().toISOString(), async release() { released.push(id); }, async checkpoint() {} };
    },
  } as unknown as SteelAdapter;
  return { adapter, released };
}
const req = (over: Partial<LeaseRequest> = {}): LeaseRequest => ({ vantage: { country: "CA", device: "desktop", authenticated: false }, purpose: "reveal", ...over });

describe("session pool", () => {
  it("C2: the eleventh lease queues until one is released", async () => {
    const { adapter } = fakeAdapter(); const pool = new SessionPool(adapter, { maxConcurrent: 10 });
    const handles = await Promise.all(Array.from({ length: 10 }, () => pool.lease(req())));
    let eleventh: SessionHandle | undefined;
    const p = pool.lease(req()).then((h) => { eleventh = h; });
    await new Promise((r) => setTimeout(r, 20));
    expect(eleventh).toBeUndefined(); expect(pool.queuedCount()).toBe(1);
    await handles[0].release(); await p;
    expect(eleventh).toBeDefined(); expect(pool.activeCount()).toBe(10);
  });

  it("C6: a lease waits for profile readiness", async () => {
    const { adapter } = fakeAdapter(); let ready = false;
    const pool = new SessionPool(adapter, { isProfileReady: async () => ready });
    await expect(pool.lease(req({ profileId: "p1", purpose: "walker" }))).rejects.toThrow(/not ready/);
    ready = true;
    await expect(pool.lease(req({ profileId: "p1", purpose: "walker" }))).resolves.toBeTruthy();
  });

  it("C7: a saved login is refused from a foreign vantage", async () => {
    const { adapter } = fakeAdapter();
    const pool = new SessionPool(adapter, { homeCountryOf: async () => "CA", isProfileReady: async () => true });
    await expect(pool.lease(req({ profileId: "p1", purpose: "walker", vantage: { country: "DE", device: "desktop", authenticated: true } }))).rejects.toThrow(/bound to CA/);
    await expect(pool.lease(req({ profileId: "p1", purpose: "walker" }))).resolves.toBeTruthy();
  });

  it("one lease per account at a time", async () => {
    const { adapter } = fakeAdapter(); const pool = new SessionPool(adapter);
    const a = await pool.lease(req({ accountRef: "acc1", purpose: "walker" }));
    let second: SessionHandle | undefined; const p = pool.lease(req({ accountRef: "acc1", purpose: "walker" })).then((h) => { second = h; });
    await new Promise((r) => setTimeout(r, 20)); expect(second).toBeUndefined();
    await a.release(); await p; expect(second).toBeDefined();
  });

  it("C10: a job that ignores the deadline is force-released", async () => {
    vi.useFakeTimers();
    const { adapter, released } = fakeAdapter(); const pool = new SessionPool(adapter, { forcedReleaseMs: 1000 });
    await pool.lease(req());
    await vi.advanceTimersByTimeAsync(1100);
    expect(released).toEqual(["s1"]); expect(pool.activeCount()).toBe(0);
    vi.useRealTimers();
  });
});

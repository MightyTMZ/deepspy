// C9 deadline checkpoint and C11 crash reconciliation. Offline with a fake adapter and a temp journal.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
    async liveSessionIds() { return ["s1", "s3", "other-app-session"]; },
    async releaseSession(id: string) { released.push(`reconciled:${id}`); },
  } as unknown as SteelAdapter;
  return { adapter, released };
}
const req = (): LeaseRequest => ({ vantage: { country: "CA", device: "desktop", authenticated: false }, purpose: "walker" });
const tmpJournal = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "periscope-pool-")), "sessions.local.json");

describe("C9 deadline", () => {
  it("calls onDeadline with the last checkpoint, then releases the session", async () => {
    const { adapter, released } = fakeAdapter();
    const seen: unknown[] = [];
    const pool = new SessionPool(adapter, { deadlineMs: 200, forcedReleaseMs: 5000, journalPath: tmpJournal(), onDeadline: async (_id, cp) => { seen.push(cp); } });
    const h = await pool.lease(req());
    await h.checkpoint({ step: 7, url: "https://app.test/settings" });
    await new Promise((r) => setTimeout(r, 400));
    expect(seen).toEqual([{ step: 7, url: "https://app.test/settings" }]);
    expect(released).toEqual(["s1"]);
    expect(pool.activeCount()).toBe(0);
  });

  it("deadlineAt on the handle matches the pool's deadline, not the adapter's", async () => {
    const { adapter } = fakeAdapter();
    const pool = new SessionPool(adapter, { deadlineMs: 60_000, journalPath: tmpJournal() });
    const before = Date.now();
    const h = await pool.lease(req());
    const dl = new Date(h.deadlineAt).getTime();
    expect(dl - before).toBeGreaterThan(55_000); expect(dl - before).toBeLessThan(65_000);
    await h.release();
  });
});

describe("C11 reconciliation", () => {
  it("journals owned sessions and releases only those still live after a crash", async () => {
    const { adapter, released } = fakeAdapter();
    const journal = tmpJournal();
    const pool = new SessionPool(adapter, { journalPath: journal });
    const a = await pool.lease(req()); const b = await pool.lease(req()); const c = await pool.lease(req());
    await b.release(); // s2 closed cleanly; s1 and s3 are "left open by a crash"
    expect(JSON.parse(fs.readFileSync(journal, "utf8"))).toEqual(["s1", "s3"]);
    // simulate restart: a fresh pool reading the same journal
    const pool2 = new SessionPool(adapter, { journalPath: journal });
    const reconciled = await pool2.reconcile();
    expect(reconciled).toEqual(["s1", "s3"]);
    expect(released).toContain("reconciled:s1"); expect(released).toContain("reconciled:s3");
    expect(released).not.toContain("reconciled:other-app-session"); // never touches sessions we do not own
    expect(JSON.parse(fs.readFileSync(journal, "utf8"))).toEqual([]);
    void a; void c;
  });
});

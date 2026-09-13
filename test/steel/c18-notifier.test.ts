// C18: notifier posts within 5 seconds and repeats every 2 minutes. Offline, webhook mocked.
import { describe, it, expect, vi } from "vitest";
import { Notifier } from "../../src/steel/notifier.js";

describe("C18 notifier", () => {
  it("posts the webhook immediately and repeats", async () => {
    vi.useFakeTimers();
    const posts: unknown[] = [];
    const fetchImpl = (async (_url: unknown, init: { body: string }) => { posts.push(JSON.parse(init.body)); return new Response("ok"); }) as unknown as typeof fetch;
    const n = new Notifier({ webhookUrl: "https://hook.test", desktop: false, repeatMs: 2 * 60_000, fetchImpl });
    await n.notify(
      { jobId: "job1", viewerUrl: "https://viewer.test/s", wall: "captcha", generation: 1, state: "awaiting_human" },
      { jobId: "job1", sessionId: "s", wall: "captcha", screenshotPath: "x.png", generation: 1 },
    );
    expect(posts).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(4 * 60_000 + 10);
    expect(posts).toHaveLength(3);
    n.stop("job1");
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(posts).toHaveLength(3);
    expect(posts[0]).toMatchObject({ jobId: "job1", wall: "captcha", viewerUrl: "https://viewer.test/s" });
    vi.useRealTimers();
  });
});

// I1 prerequisite: the shared EventSink contract over Ayaan's Storage. Offline, in-memory SQLite.
import { describe, it, expect } from "vitest";
import { Storage } from "@periscope/knowledge";
import { StorageSink } from "../../src/integration/storage-sink.js";
import type { Observation } from "@periscope/contracts";

function fresh() {
  const storage = Storage.open({ path: ":memory:" });
  storage.migrate();
  return storage;
}

const obs = (jobId: string, text: string): Observation => ({
  id: `sha-${jobId}-${text}`, runId: "run1", jobId, competitor: "acme", url: "https://acme.test/pricing",
  layer: "hidden", source: "browser", kind: "text", text,
  vantage: { country: "CA", device: "desktop", authenticated: false }, perception: "dom",
  revealedBy: { action: "click", label: "Legal tab" }, missedByFetch: true, capturedAt: new Date().toISOString(),
});

describe("StorageSink implements EventSink over Storage", () => {
  it("creates the run and the job on first sight, then stores events without a registration step", async () => {
    const storage = fresh();
    const sink = new StorageSink({ storage, runId: "run1", category: "pm-tools", capUsd: 12, jobHints: () => ({ purpose: "reveal", competitor: "acme" }) });
    await sink.write({ type: "job_state", data: { jobId: "jobA", state: "starting" } });
    await sink.write({ type: "observation", data: obs("jobA", "Service Level Agreement") });
    await sink.write({ type: "handoff", data: { jobId: "jobA", viewerUrl: "https://viewer.test/x", wall: "captcha", generation: 1, state: "awaiting_human" } });
    expect(storage.getRun("run1")?.id).toBe("run1");
    expect(storage.getJob("jobA")?.competitor).toBe("acme");
    expect(storage.countObservations("run1")).toBe(1);
    expect(storage.countEvents("run1")).toBe(3);
  });

  it("is idempotent on observation ids and never throws on a duplicate", async () => {
    const storage = fresh();
    const sink = new StorageSink({ storage, runId: "run1" });
    await sink.write({ type: "observation", data: obs("jobB", "Terms of Service") });
    await expect(sink.write({ type: "observation", data: obs("jobB", "Terms of Service") })).resolves.toBeUndefined();
    expect(storage.countObservations("run1")).toBe(1);
  });

  it("stores run-level events without a job", async () => {
    const storage = fresh();
    const sink = new StorageSink({ storage, runId: "run1" });
    await sink.write({ type: "spend", data: { runId: "run1", usd: 0.42, cap: 12 } });
    await sink.write({ type: "run_done", data: { runId: "run1" } });
    expect(storage.countEvents("run1")).toBe(2);
  });
});

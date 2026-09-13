// In-process run launcher shared by the CLI (src/run.ts) and the API (src/api). One Steel segment per process,
// one StorageSink per run, events routed by job id so several runs can share the pool's ten slots.
import { Storage } from "@periscope/knowledge";
import type { Event, EventSink, HandoffEvent, Vantage } from "@periscope/contracts";
import { Coordinator, type Job, type JobType } from "../coordinator.js";
import type { SteelSegment } from "../steel/segment.js";
import { StorageSink } from "./storage-sink.js";

export interface RunSpec {
  runId: string;
  competitor: string;
  url: string;
  pages?: string[];          // paths or full urls, resolved against url; default ["/"]
  jobs?: JobType[];          // default surface, benchmark, reveal
  countries?: string[];      // default CA, US, DE (borders and the walker's home country)
  capUsd?: number;           // default 12
  start?: string;            // walker start url
  profileId?: string;
  accountRef?: string;
  category?: string;
  goal?: string;
}

export interface LaunchDeps {
  storage: Storage;
  segment: Pick<SteelSegment, "acquireSession" | "steel" | "onWall" | "waitForResolution">;
  router: RouterSink;
  onEvent?: (e: Event) => void;
  onHandoff?: (h: HandoffEvent) => void;
}

export interface LaunchHandle {
  runId: string;
  coordinator: Coordinator;
  done: Promise<{ completedJobs: Job[]; failedJobs: Job[] }>;
  cancel: () => Promise<void>;
}

/** Routes segment-level events (handoffs) to the run that owns the job. */
export class RouterSink implements EventSink {
  private readonly byJob = new Map<string, EventSink>();
  register(jobId: string, sink: EventSink): void { this.byJob.set(jobId, sink); }
  async write(event: Event): Promise<void> {
    const jobId = "jobId" in event.data ? (event.data as { jobId?: string }).jobId : undefined;
    const sink = jobId ? this.byJob.get(jobId) : undefined;
    if (sink) await sink.write(event);
    else console.warn(`[router] event ${event.type} for unknown job ${jobId ?? "?"} dropped`);
  }
}

export function resolvePages(root: string, pages: string[] | undefined): string[] {
  return (pages && pages.length ? pages : ["/"]).map((p) => {
    const raw = p.trim();
    // Git Bash on Windows rewrites a leading "/" argument into "C:/Program Files/Git/..." before Node sees it.
    if (/^[a-z]:[\/]/i.test(raw) || raw.startsWith("file:")) throw new Error(`page "${raw}" looks like a local path. Run with MSYS_NO_PATHCONV=1 or pass full URLs.`);
    return new URL(raw, root).toString();
  });
}

export function buildJobs(spec: RunSpec): Omit<Job, "id" | "state">[] {
  const pages = resolvePages(spec.url, spec.pages);
  const countries = spec.countries ?? ["CA", "US", "DE"];
  const desktop: Vantage = { country: null, device: "desktop", authenticated: false };
  const jobs: Omit<Job, "id" | "state">[] = [];
  for (const t of spec.jobs ?? ["surface", "benchmark", "reveal"]) {
    if (t === "surface" || t === "benchmark" || t === "reveal") jobs.push({ type: t, competitor: spec.competitor, urls: pages, vantage: desktop });
    if (t === "borders") jobs.push({ type: "borders", competitor: spec.competitor, urls: [pages[0]], vantages: countries.flatMap((c) => [{ country: c, device: "desktop", authenticated: false }, { country: c, device: "mobile", authenticated: false }] as Vantage[]) });
    if (t === "walker") {
      if (!spec.start) throw new Error("start url is required for a walker job");
      jobs.push({ type: "walker", competitor: spec.competitor, urls: [spec.start], vantage: { country: countries[0] ?? null, device: "desktop", authenticated: true }, profileId: spec.profileId, accountRef: spec.accountRef });
    }
  }
  return jobs;
}

export function launchRun(spec: RunSpec, deps: LaunchDeps): LaunchHandle {
  const capUsd = spec.capUsd ?? 12;
  const jobs = buildJobs(spec);
  const jobHints = new Map<string, { purpose: "surface" | "reveal" | "borders" | "walker" | "setup"; competitor: string; url?: string }>();
  const store: EventSink = new StorageSink({ storage: deps.storage, runId: spec.runId, category: spec.category ?? "demo", capUsd, jobHints: (id) => jobHints.get(id) });
  const tee: EventSink = {
    async write(event: Event) {
      await store.write(event);
      deps.onEvent?.(event);
      if (event.type === "handoff") deps.onHandoff?.(event.data);
    },
  };

  const coordinator = new Coordinator({
    runId: spec.runId, runBudgetUsd: capUsd, jobBudgetUsd: Math.min(capUsd, 4), runStartedAt: new Date().toISOString(),
    sink: tee, acquireSession: deps.segment.acquireSession, steel: deps.segment.steel,
    onWall: (wall, handle) => deps.segment.onWall(wall, handle),
    waitForResolution: deps.segment.waitForResolution,
  });
  coordinator.enqueue(jobs);
  for (const j of coordinator.getState().queued) {
    jobHints.set(j.id, { purpose: j.type === "walker" ? "walker" : j.type === "borders" ? "borders" : j.type === "reveal" ? "reveal" : "surface", competitor: spec.competitor, url: j.urls[0] });
    deps.router.register(j.id, tee);
  }

  const done = (async () => {
    const result = await coordinator.run();
    await tee.write({ type: "run_done", data: { runId: spec.runId } });
    return result;
  })();

  return {
    runId: spec.runId, coordinator, done,
    cancel: async () => {
      for (const j of coordinator.getState().queued) await coordinator.cancel(j.id);
      deps.storage.setRunStatus(spec.runId, "cancelled", "cancelled through the API; running jobs finish their current page");
    },
  };
}

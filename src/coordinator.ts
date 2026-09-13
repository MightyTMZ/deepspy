import { randomUUID } from "node:crypto";
import type {
  LeaseRequest,
  SessionHandle,
  EventSink,
  JobState,
  Vantage,
} from "@periscope/contracts";
import { Meter, BudgetExceededError } from "./meter.js";
import { Policy } from "./policy.js";
import { scrapeSurface } from "./surface.js";
import { fetchBenchmark } from "./benchmark.js";
import { reveal } from "./reveal.js";
import { walk } from "./walker.js";
import { runBorders } from "./borders.js";
import { createStagehand } from "./utils/stagehand-bridge.js";
import Steel from "steel-sdk";

export type JobType = "surface" | "benchmark" | "reveal" | "borders" | "walker";

export interface Job {
  id: string;
  type: JobType;
  competitor: string;
  urls: string[];
  vantage?: Vantage;
  vantages?: Vantage[]; // for borders
  profileId?: string;
  accountRef?: string;
  state: JobState;
  reason?: string;
}

export interface CoordinatorConfig {
  runId: string;
  runBudgetUsd: number;
  jobBudgetUsd: number;
  runStartedAt: string;
  sink: EventSink;
  acquireSession: (req: LeaseRequest) => Promise<SessionHandle>;
  steel: Steel;
}

const MAX_CONCURRENT = 10;

/**
 * Job queue over Person C's session pool.
 * One job = one session = one agent. Max 10 concurrent.
 *
 * Demo order: walkers first, reveal jobs fill remaining slots,
 * borders after walkers release.
 *
 * Never more than one agent per session.
 * Never an agent that creates jobs or sessions.
 */
export class Coordinator {
  private config: CoordinatorConfig;
  private meter: Meter;
  private policy: Policy;
  private jobs: Job[] = [];
  private running = new Set<string>();

  constructor(config: CoordinatorConfig) {
    this.config = config;
    this.meter = new Meter({
      jobBudgetUsd: config.jobBudgetUsd,
      runBudgetUsd: config.runBudgetUsd,
      sink: config.sink,
    });
    this.policy = new Policy();
  }

  /**
   * Enqueue jobs for a run.
   */
  enqueue(jobs: Omit<Job, "id" | "state">[]): void {
    for (const job of jobs) {
      this.jobs.push({
        ...job,
        id: randomUUID(),
        state: "queued",
      });
    }
  }

  /**
   * Start processing the queue. Returns when all jobs complete or budget exhausted.
   */
  async run(): Promise<{ completedJobs: Job[]; failedJobs: Job[] }> {
    // Sort: walkers first, then reveal, then borders, then surface/benchmark
    const priority: Record<JobType, number> = {
      walker: 0,
      reveal: 1,
      borders: 2,
      surface: 3,
      benchmark: 4,
    };
    this.jobs.sort((a, b) => priority[a.type] - priority[b.type]);

    const promises: Promise<void>[] = [];

    for (const job of this.jobs) {
      // Wait if at capacity
      while (this.running.size >= MAX_CONCURRENT) {
        await Promise.race(promises);
      }

      // Check run budget
      if (!this.meter.canProceed(job.id)) {
        job.state = "cancelled";
        job.reason = "Run budget exceeded";
        await this.emitJobState(job);
        continue;
      }

      const p = this.executeJob(job).finally(() => {
        this.running.delete(job.id);
      });
      this.running.add(job.id);
      promises.push(p);
    }

    // Wait for all to complete
    await Promise.allSettled(promises);

    return {
      completedJobs: this.jobs.filter(
        (j) => j.state === "completed" || j.state === "partial",
      ),
      failedJobs: this.jobs.filter((j) => j.state === "failed"),
    };
  }

  /**
   * Cancel a running job.
   */
  async cancel(jobId: string): Promise<void> {
    const job = this.jobs.find((j) => j.id === jobId);
    if (job) {
      job.state = "cancelled";
      job.reason = "Manually cancelled";
      await this.emitJobState(job);
    }
  }

  /**
   * Get current state.
   */
  getState(): {
    queued: Job[];
    running: Job[];
    completed: Job[];
    failed: Job[];
  } {
    return {
      queued: this.jobs.filter((j) => j.state === "queued"),
      running: this.jobs.filter((j) => j.state === "running"),
      completed: this.jobs.filter(
        (j) => j.state === "completed" || j.state === "partial",
      ),
      failed: this.jobs.filter(
        (j) => j.state === "failed" || j.state === "cancelled",
      ),
    };
  }

  private async emitJobState(job: Job): Promise<void> {
    await this.config.sink.write({
      type: "job_state",
      data: { jobId: job.id, state: job.state, reason: job.reason },
    });
  }

  private async executeJob(job: Job): Promise<void> {
    job.state = "starting";
    await this.emitJobState(job);

    try {
      job.state = "running";
      await this.emitJobState(job);

      switch (job.type) {
        case "surface":
          await this.runSurface(job);
          break;
        case "benchmark":
          await this.runBenchmark(job);
          break;
        case "reveal":
          await this.runReveal(job);
          break;
        case "walker":
          await this.runWalker(job);
          break;
        case "borders":
          await this.runBordersJob(job);
          break;
      }

      if (job.state === "running") {
        job.state = "completed";
      }
    } catch (err) {
      if (err instanceof BudgetExceededError) {
        job.state = "partial";
        job.reason = err.message;
      } else {
        job.state = "failed";
        job.reason = err instanceof Error ? err.message : String(err);
      }
    }

    await this.emitJobState(job);
  }

  private async runSurface(job: Job): Promise<void> {
    for (const url of job.urls) {
      await scrapeSurface({
        steel: this.config.steel,
        url,
        competitor: job.competitor,
        runId: this.config.runId,
        jobId: job.id,
        vantage: job.vantage ?? {
          country: null,
          device: "desktop",
          authenticated: false,
        },
        sink: this.config.sink,
      });
    }
  }

  private async runBenchmark(job: Job): Promise<void> {
    for (const url of job.urls) {
      await fetchBenchmark({
        url,
        competitor: job.competitor,
        runId: this.config.runId,
        jobId: job.id,
        runStartedAt: this.config.runStartedAt,
        vantage: job.vantage ?? {
          country: null,
          device: "desktop",
          authenticated: false,
        },
        sink: this.config.sink,
      });
    }
  }

  private async runReveal(job: Job): Promise<void> {
    const vantage = job.vantage ?? {
      country: null,
      device: "desktop",
      authenticated: false,
    };

    const handle = await this.config.acquireSession({
      vantage,
      purpose: "reveal",
    });

    try {
      const { stagehand, page } = await createStagehand(handle);

      try {
        for (const url of job.urls) {
          await page.goto(url, { waitUntil: "domcontentloaded" });
          await page.waitForTimeout(1000);

          // Get surface baseline for this URL
          const surfaceResult = await scrapeSurface({
            steel: this.config.steel,
            url,
            competitor: job.competitor,
            runId: this.config.runId,
            jobId: job.id,
            vantage,
            sink: this.config.sink,
          });

          await reveal({
            runId: this.config.runId,
            jobId: job.id,
            competitor: job.competitor,
            url,
            surfaceBaseline: surfaceResult.rawMarkdown || surfaceResult.rawHtml,
            stagehand,
            page,
            handle,
            meter: this.meter,
            policy: this.policy,
            sink: this.config.sink,
          });
        }
      } finally {
        await stagehand.close();
      }
    } finally {
      await handle.release();
    }
  }

  private async runWalker(job: Job): Promise<void> {
    const vantage = job.vantage ?? {
      country: null,
      device: "desktop",
      authenticated: true,
    };

    const handle = await this.config.acquireSession({
      vantage,
      profileId: job.profileId,
      accountRef: job.accountRef,
      purpose: "walker",
    });

    try {
      const { stagehand, page } = await createStagehand(handle);

      try {
        const result = await walk({
          runId: this.config.runId,
          jobId: job.id,
          competitor: job.competitor,
          startUrl: job.urls[0],
          stagehand,
          page,
          handle,
          meter: this.meter,
          policy: this.policy,
          sink: this.config.sink,
        });

        if (result.wallDetected) {
          job.state = "awaiting_human";
          await this.emitJobState(job);
        } else if (result.stoppedReason === "budget") {
          job.state = "partial";
          job.reason = "Budget exceeded";
        }
      } finally {
        await stagehand.close();
      }
    } finally {
      await handle.release();
    }
  }

  private async runBordersJob(job: Job): Promise<void> {
    if (!job.vantages || job.vantages.length === 0) return;

    // Get surface baseline
    const surfaceResult = await scrapeSurface({
      steel: this.config.steel,
      url: job.urls[0],
      competitor: job.competitor,
      runId: this.config.runId,
      jobId: job.id,
      vantage: { country: null, device: "desktop", authenticated: false },
      sink: this.config.sink,
    });

    await runBorders({
      runId: this.config.runId,
      jobId: job.id,
      competitor: job.competitor,
      url: job.urls[0],
      vantages: job.vantages,
      surfaceBaseline: surfaceResult.rawMarkdown || surfaceResult.rawHtml,
      meter: this.meter,
      policy: this.policy,
      sink: this.config.sink,
      acquireSession: this.config.acquireSession,
    });
  }
}

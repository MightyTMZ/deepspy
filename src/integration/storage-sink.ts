// Integration glue between the coordinator (Person B), the Steel segment (Fahad), and Ayaan's Storage.
// Implements the shared EventSink contract over Storage so B and C never touch the database.
//
// Why it exists: the contract says write(event) returns a promise and takes only the event; Storage.write is
// synchronous, takes an association context, and throws when the run or job row does not exist yet.
// This sink creates the run once and creates a job row the first time it sees a job id, so the coordinator
// can emit events for jobs it generated with randomUUID() without a separate registration step.

import type { Event, EventSink, LeaseRequest } from "@periscope/contracts";
import type { Storage } from "@periscope/knowledge";

export interface StorageSinkOptions {
  storage: Storage;
  runId: string;
  goal?: string;
  category?: string;
  capUsd?: number;
  /** Optional hint for a job's purpose and competitor when the sink has to create the row on first sight. */
  jobHints?: (jobId: string) => { purpose?: LeaseRequest["purpose"]; competitor?: string; url?: string } | undefined;
}

export class StorageSink implements EventSink {
  private readonly knownJobs = new Set<string>();
  private runCreated = false;

  constructor(private readonly opts: StorageSinkOptions) {}

  async write(event: Event): Promise<void> {
    this.ensureRun();
    const jobId = jobIdOf(event);
    if (jobId) this.ensureJob(jobId);
    const context = { runId: this.opts.runId, ...(jobId ? { jobId } : {}) };
    const outcome = this.opts.storage.write(event, context);
    if (outcome.status === "duplicate") return; // observation already stored; the contract says ids are deterministic
  }

  private ensureRun(): void {
    if (this.runCreated) return;
    const { storage, runId, goal, category, capUsd } = this.opts;
    if (!storage.getRun(runId)) storage.createRun({ id: runId, goal, category, capUsd, status: "running" });
    this.runCreated = true;
  }

  private ensureJob(jobId: string): void {
    if (this.knownJobs.has(jobId)) return;
    const { storage, runId } = this.opts;
    if (!storage.getJob(jobId)) {
      const hint = this.opts.jobHints?.(jobId) ?? {};
      storage.createJob({ id: jobId, runId, purpose: hint.purpose ?? "reveal", competitor: hint.competitor, url: hint.url, state: "queued" });
    }
    this.knownJobs.add(jobId);
  }
}

function jobIdOf(event: Event): string | undefined {
  switch (event.type) {
    case "observation": return event.data.jobId;
    case "receipt": return event.data.jobId;
    case "handoff": return event.data.jobId;
    case "job_state": return event.data.jobId;
    default: return undefined;
  }
}

import type { Storage } from "@periscope/knowledge";
import { extractFeatures, type Complete } from "./extract.js";
import { meteredCompletion } from "./metered-completion.js";

/** Retry failed competitors independently, without duplicate concurrent extraction. */
export class ExtractionWorker {
  private active = false;
  private attempts = new Map<string, number>();
  private done = new Set<string>();
  constructor(private storage: Storage, private complete: Complete, private since: string) {}
  async tick(): Promise<void> {
    if (this.active) return;
    this.active = true;
    try {
      for (const run of this.storage.listRuns(100)) {
        if (!["completed", "partial"].includes(run.status) || run.createdAt < this.since) continue;
        const competitors = new Set(this.storage.getJobsByRun(run.id).map((j) => j.competitor).filter((c): c is string => Boolean(c)));
        for (const competitor of competitors) {
          const key = `${run.id}:${competitor}`;
          if (this.done.has(key) || (this.attempts.get(key) ?? 0) >= 3) continue;
          if (this.storage.getFindingsByRun(run.id, "feature").some((f) => f.competitor === competitor)) { this.done.add(key); continue; }
          this.attempts.set(key, (this.attempts.get(key) ?? 0) + 1);
          try {
            await extractFeatures({ storage: this.storage, runId: run.id, competitor, complete: meteredCompletion(this.storage, run.id, this.complete) });
            this.done.add(key);
          } catch (e) { console.warn(`[${run.id}] extraction ${competitor}: ${(e as Error).message}`); }
        }
      }
    } finally { this.active = false; }
  }
}

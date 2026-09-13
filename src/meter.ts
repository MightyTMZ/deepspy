import type { ActionReceipt, EventSink } from "@periscope/contracts";

// Opus 5 pricing (dollars per million tokens) — update if pricing changes
const OPUS_INPUT_RATE = 15 / 1_000_000;
const OPUS_OUTPUT_RATE = 75 / 1_000_000;

export interface MeterConfig {
  jobBudgetUsd: number;
  runBudgetUsd: number;
  sink: EventSink;
}

export class Meter {
  private jobSpends = new Map<string, number>();
  private totalSpend = 0;
  private callCount = 0;
  private config: MeterConfig;

  constructor(config: MeterConfig) {
    this.config = config;
  }

  /**
   * Convert token counts to USD.
   */
  static tokensToUsd(tokensIn: number, tokensOut: number): number {
    return tokensIn * OPUS_INPUT_RATE + tokensOut * OPUS_OUTPUT_RATE;
  }

  /**
   * Record an Opus API call. Returns the receipt. Throws if budget exceeded.
   */
  recordCall(params: {
    jobId: string;
    runId: string;
    step: number;
    action: string;
    target?: string;
    before: string;
    after: string;
    tokensIn: number;
    tokensOut: number;
    ok: boolean;
  }): ActionReceipt {
    const usd = Meter.tokensToUsd(params.tokensIn, params.tokensOut);

    const currentJobSpend = (this.jobSpends.get(params.jobId) ?? 0) + usd;
    this.jobSpends.set(params.jobId, currentJobSpend);
    this.totalSpend += usd;
    this.callCount++;

    if (currentJobSpend > this.config.jobBudgetUsd) {
      throw new BudgetExceededError("job", currentJobSpend, this.config.jobBudgetUsd);
    }
    if (this.totalSpend > this.config.runBudgetUsd) {
      throw new BudgetExceededError("run", this.totalSpend, this.config.runBudgetUsd);
    }

    const receipt: ActionReceipt = {
      jobId: params.jobId,
      step: params.step,
      action: params.action,
      target: params.target,
      before: params.before,
      after: params.after,
      ok: params.ok,
      tokensIn: params.tokensIn,
      tokensOut: params.tokensOut,
      usd,
    };

    // Emit a spend event every 10 calls
    if (this.callCount % 10 === 0) {
      void this.emitSpend(params.runId);
    }

    return receipt;
  }

  /**
   * Check if the budget allows another step.
   */
  canProceed(jobId: string): boolean {
    const jobSpend = this.jobSpends.get(jobId) ?? 0;
    return (
      jobSpend < this.config.jobBudgetUsd &&
      this.totalSpend < this.config.runBudgetUsd
    );
  }

  /**
   * Get current spend for a job.
   */
  jobSpend(jobId: string): number {
    return this.jobSpends.get(jobId) ?? 0;
  }

  /**
   * Get current spend for the entire run.
   */
  runSpend(): number {
    return this.totalSpend;
  }

  /**
   * Emit a spend event.
   */
  async emitSpend(runId: string): Promise<void> {
    await this.config.sink.write({
      type: "spend",
      data: {
        runId,
        usd: this.totalSpend,
        cap: this.config.runBudgetUsd,
      },
    });
  }
}

export class BudgetExceededError extends Error {
  constructor(
    public scope: "job" | "run",
    public spent: number,
    public cap: number,
  ) {
    super(`${scope} budget exceeded: $${spent.toFixed(4)} > $${cap.toFixed(2)}`);
    this.name = "BudgetExceededError";
  }
}

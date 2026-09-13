import type {
  Observation,
  Vantage,
  LeaseRequest,
  SessionHandle,
  EventSink,
} from "@periscope/contracts";
import { Meter } from "./meter.js";
import { Policy } from "./policy.js";
import { reveal } from "./reveal.js";
import { revealDeterministic, LIGHT_STRATEGIES } from "./reveal-deterministic.js";
import { createStagehand } from "./utils/stagehand-bridge.js";

export interface BordersConfig {
  runId: string;
  jobId: string;
  competitor: string;
  url: string;
  vantages: Vantage[];
  surfaceBaseline: string;
  meter: Meter;
  policy: Policy;
  sink: EventSink;
  acquireSession: (req: LeaseRequest) => Promise<SessionHandle>;
}

/**
 * Same URL across countries/devices in parallel.
 * Each vantage gets its own anonymous session from the pool.
 * Every observation carries its vantage. B captures; Ayan compares.
 */
export async function runBorders(
  config: BordersConfig,
): Promise<Observation[]> {
  const allObservations: Observation[] = [];

  const results = await Promise.allSettled(
    config.vantages.map(async (vantage) => {
      const handle = await config.acquireSession({
        vantage,
        purpose: "borders",
      });

      try {
        const useModel = Boolean(process.env.ANTHROPIC_API_KEY);
        const sh = useModel ? await createStagehand(handle) : undefined;
        const page = sh?.page ?? handle.page;

        try {
          await page.goto(config.url, { waitUntil: "load", timeout: 60_000 });
          await page.waitForTimeout(1000);

          const det = await revealDeterministic({
            runId: config.runId,
            jobId: config.jobId,
            competitor: config.competitor,
            url: config.url,
            surfaceBaseline: config.surfaceBaseline,
            page,
            handle,
            sink: config.sink,
            strategies: LIGHT_STRATEGIES, // borders compares the same page across vantages; a full reveal per vantage is too slow
            emitBaselineAs: "borders",    // every vantage records what it saw, so the grid has rows to compare
          });
          if (!sh) return det.observations;

          const result = await reveal({
            runId: config.runId,
            jobId: config.jobId,
            competitor: config.competitor,
            url: config.url,
            surfaceBaseline: config.surfaceBaseline,
            stagehand: sh.stagehand,
            page,
            handle,
            meter: config.meter,
            policy: config.policy,
            sink: config.sink,
          });

          return [...det.observations, ...result.observations];
        } finally {
          await sh?.close();
        }
      } finally {
        await handle.release();
      }
    }),
  );

  for (const result of results) {
    if (result.status === "fulfilled") {
      allObservations.push(...result.value);
    } else {
      console.error("Borders vantage failed:", result.reason);
    }
  }

  return allObservations;
}

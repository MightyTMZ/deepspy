import type { Observation, Vantage, EventSink } from "@periscope/contracts";
import { createObservation } from "./utils/observation-factory.js";
import { splitBlocks, deduplicateNav } from "./utils/text.js";

export interface BenchmarkResult {
  observations: Observation[];
  rawResponse: string;
  fetchedAt: string;
  stale: boolean;
  failed: boolean;
}

/**
 * External fetch tool comparison. Source: "benchmark_fetch".
 * Measurement only, never a dependency.
 *
 * If the fetch fails: counter = "uncertain", never zero.
 * If older than the run: URL marked stale, counter = "uncertain".
 */
export async function fetchBenchmark(params: {
  url: string;
  competitor: string;
  runId: string;
  jobId: string;
  runStartedAt: string;
  vantage: Vantage;
  sink: EventSink;
  fetchFn?: (url: string) => Promise<{ text: string; timestamp: string }>;
}): Promise<BenchmarkResult> {
  const defaultFetch = async (
    url: string,
  ): Promise<{ text: string; timestamp: string }> => {
    const resp = await fetch(url);
    return { text: await resp.text(), timestamp: new Date().toISOString() };
  };

  const fetchFn = params.fetchFn ?? defaultFetch;

  let rawResponse = "";
  let fetchedAt = "";
  let failed = false;

  try {
    const result = await fetchFn(params.url);
    rawResponse = result.text;
    fetchedAt = result.timestamp;
  } catch {
    failed = true;
    fetchedAt = new Date().toISOString();

    // Emit uncertain counter
    await params.sink.write({
      type: "counter",
      data: {
        competitor: params.competitor,
        url: params.url,
        missed: "uncertain",
      },
    });

    return {
      observations: [],
      rawResponse: "",
      fetchedAt,
      stale: false,
      failed: true,
    };
  }

  // Check staleness: benchmark must be newer than the run start
  const stale = new Date(fetchedAt) < new Date(params.runStartedAt);

  if (stale) {
    await params.sink.write({
      type: "counter",
      data: {
        competitor: params.competitor,
        url: params.url,
        missed: "uncertain",
      },
    });
  }

  // Parse into observations
  const blocks = deduplicateNav(splitBlocks(rawResponse));
  const observations: Observation[] = [];

  for (const block of blocks) {
    if (block.length < 3) continue;

    const obs = createObservation({
      runId: params.runId,
      jobId: params.jobId,
      competitor: params.competitor,
      url: params.url,
      layer: "surface",
      source: "benchmark_fetch",
      kind: "text",
      text: block,
      vantage: params.vantage,
      perception: "dom",
    });

    observations.push(obs);
  }

  return { observations, rawResponse, fetchedAt, stale, failed };
}

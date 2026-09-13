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

  // Parse into observations. A fetch tool returns HTML; the fair comparison is its visible text, so strip
  // scripts, styles and tags before splitting into blocks (segment C: the side-by-side needs this count).
  const blocks = deduplicateNav(splitBlocks(htmlToText(rawResponse)));
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
    await params.sink.write({ type: "observation", data: obs });
  }

  return { observations, rawResponse, fetchedAt, stale, failed };
}

/** Visible text of an HTML document without a browser: drop script/style/noscript, break on block tags, decode common entities. */
export function htmlToText(html: string): string {
  if (!/<[a-z!][\s\S]*>/i.test(html)) return html;
  return html
    .replace(/<(script|style|noscript|template|svg)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|section|article|li|ul|ol|h[1-6]|tr|td|th|br|hr|header|footer|nav|main|aside|blockquote|pre|table|form|label|option|button|a|span)>/gi, "\n\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/[ \t]+/g, " ");
}

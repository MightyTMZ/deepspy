// Coverage: for one run, what did Periscope see per page that a fetch tool did not.
// Pure function over observations; the inspector CLI and Ayaan's API can both render it.
import type { Observation } from "@periscope/contracts";
import { vantageKey } from "./borders-grid.js";

export interface PageCoverage {
  url: string;
  surface: number;        // lines a fetch tool also gets
  hidden: number;         // lines revealed by an action
  missedByFetch: number;  // hidden lines absent from the surface baseline
  documents: number;      // files linked only after an action
  vantages: string[];     // "CA/desktop" ... seen for this page
  byAction: Record<string, number>;
}

export interface RunCoverage {
  runId: string;
  pages: PageCoverage[];
  totals: { surface: number; hidden: number; missedByFetch: number; documents: number; authenticated: number };
}

export function coverage(runId: string, observations: Observation[]): RunCoverage {
  const byUrl = new Map<string, PageCoverage>();
  const totals = { surface: 0, hidden: 0, missedByFetch: 0, documents: 0, authenticated: 0 };
  for (const o of observations) {
    if (o.runId !== runId) continue;
    const p = byUrl.get(o.url) ?? { url: o.url, surface: 0, hidden: 0, missedByFetch: 0, documents: 0, vantages: [], byAction: {} };
    const v = vantageKey(o);
    if (!p.vantages.includes(v)) p.vantages.push(v);
    if (o.layer === "surface") { p.surface++; totals.surface++; }
    if (o.layer === "hidden") {
      p.hidden++; totals.hidden++;
      if (o.missedByFetch) { p.missedByFetch++; totals.missedByFetch++; }
      if (o.kind === "document") { p.documents++; totals.documents++; }
      const a = o.revealedBy?.label ?? o.revealedBy?.action ?? "none";
      p.byAction[a] = (p.byAction[a] ?? 0) + 1;
    }
    if (o.vantage.authenticated) totals.authenticated++;
    byUrl.set(o.url, p);
  }
  return { runId, pages: [...byUrl.values()].sort((a, b) => b.missedByFetch - a.missedByFetch), totals };
}

export function renderCoverage(c: RunCoverage): string {
  const out = [`coverage ${c.runId}: surface ${c.totals.surface} | hidden ${c.totals.hidden} | missed by fetch ${c.totals.missedByFetch} | documents ${c.totals.documents} | behind login ${c.totals.authenticated}`];
  for (const p of c.pages) {
    const top = Object.entries(p.byAction).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, n]) => `${k}=${n}`).join(", ");
    out.push(`  ${p.url}\n    surface ${p.surface} | hidden ${p.hidden} | missed ${p.missedByFetch} | docs ${p.documents} | vantages ${p.vantages.join(" ")}${top ? `\n    revealed by: ${top}` : ""}`);
  }
  return out.join("\n");
}

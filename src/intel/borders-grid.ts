// Borders grid: for one URL, what did each vantage (country/device) see that the others did not?
// Pure function over observations so Ayaan's intelligence layer and the inspector can both use it.
import type { Observation } from "@periscope/contracts";

export interface VantageCell {
  key: string;                 // "CA/desktop"
  country: string | null;
  device: string;
  total: number;               // lines seen from this vantage
  unique: string[];            // lines only this vantage saw
  prices: string[];            // price-like lines seen from this vantage
}

export interface BordersGrid {
  url: string;
  vantages: VantageCell[];
  shared: number;              // lines every vantage saw
  differsByCountry: boolean;
  differsByDevice: boolean;
}

const PRICE = /(\$|€|£|CA\$|US\$|C\$|A\$|¥|₹|kr|CHF|zł)\s?\d|\d+(\.\d+)?\s*(\/|per)\s*(mo|month|yr|year|user|seat)/i;

export function vantageKey(o: Observation): string {
  return `${o.vantage.country ?? "-"}/${o.vantage.device}`;
}

/** Build the grid for one URL from borders-layer observations (any run). */
export function bordersGrid(url: string, observations: Observation[]): BordersGrid {
  const rows = observations.filter((o) => o.url === url && o.layer === "borders");
  const byVantage = new Map<string, { country: string | null; device: string; lines: Set<string> }>();
  for (const o of rows) {
    const k = vantageKey(o);
    const cell = byVantage.get(k) ?? { country: o.vantage.country, device: o.vantage.device, lines: new Set<string>() };
    cell.lines.add(o.text);
    byVantage.set(k, cell);
  }
  const cells = [...byVantage.entries()];
  const everyone = new Set<string>();
  if (cells.length > 0) {
    for (const line of cells[0][1].lines) if (cells.every(([, c]) => c.lines.has(line))) everyone.add(line);
  }
  const vantages: VantageCell[] = cells.map(([key, c]) => ({
    key, country: c.country, device: c.device, total: c.lines.size,
    unique: [...c.lines].filter((line) => cells.every(([k2, c2]) => k2 === key || !c2.lines.has(line))),
    prices: [...c.lines].filter((line) => PRICE.test(line)),
  })).sort((a, b) => a.key.localeCompare(b.key));

  const countries = new Set(vantages.map((v) => v.country ?? "-"));
  const devices = new Set(vantages.map((v) => v.device));
  const differs = (group: (v: VantageCell) => string, groups: Set<string>) => {
    if (groups.size < 2) return false;
    // two vantages that share device but differ by country (or vice versa) see different price lines
    for (const a of vantages) for (const b of vantages) {
      if (a.key >= b.key) continue;
      const sameOther = group === byCountry ? a.device === b.device : (a.country ?? "-") === (b.country ?? "-");
      if (!sameOther || group(a) === group(b)) continue;
      const pa = new Set(a.prices), pb = new Set(b.prices);
      if ([...pa].some((p) => !pb.has(p)) || [...pb].some((p) => !pa.has(p))) return true;
    }
    return false;
  };
  const byCountry = (v: VantageCell) => v.country ?? "-";
  const byDevice = (v: VantageCell) => v.device;
  return { url, vantages, shared: everyone.size, differsByCountry: differs(byCountry, countries), differsByDevice: differs(byDevice, devices) };
}

/** Compact text rendering for the CLI and the report. */
export function renderGrid(g: BordersGrid, maxLines = 8): string {
  const out = [`borders grid for ${g.url}`, `shared by every vantage: ${g.shared} lines | differs by country: ${g.differsByCountry} | differs by device: ${g.differsByDevice}`];
  for (const v of g.vantages) {
    out.push(`  ${v.key.padEnd(12)} total ${String(v.total).padStart(4)} | unique ${String(v.unique.length).padStart(3)} | prices ${v.prices.length}`);
    for (const line of v.prices.slice(0, maxLines)) out.push(`      $ ${line.slice(0, 110)}`);
    for (const line of v.unique.filter((l) => !PRICE.test(l)).slice(0, maxLines)) out.push(`      + ${line.slice(0, 110)}`);
  }
  return out.join("\n");
}

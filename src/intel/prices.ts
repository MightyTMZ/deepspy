// Pricing truth table without a model: decimal strings, currency, period, per url and vantage, each row carrying
// the observation it came from. Unknowns stay null. Opus can refine later; the API serves this today.
import type { Observation } from "@periscope/contracts";
import { PRICE, vantageKey } from "./borders-grid.js";

export interface PriceRow {
  url: string;
  country: string | null;
  device: string;
  vantage: string;
  amount: string;          // decimal string, "12.99"
  currency: string | null; // ISO code when known
  period: "month" | "year" | "week" | "day" | null;
  text: string;
  observationId: string;
  layer: Observation["layer"];
}

const SYMBOLS: Array<[RegExp, string]> = [
  [/CA\$|C\$|CAD/, "CAD"], [/US\$|USD/, "USD"], [/A\$|AUD/, "AUD"], [/€|EUR/, "EUR"], [/£|GBP/, "GBP"], [/¥|JPY/, "JPY"],
  [/₹|INR/, "INR"], [/CHF/, "CHF"], [/zł|PLN/, "PLN"], [/\bkr\b|SEK|NOK|DKK/, "SEK"], [/\$/, "USD"],
];

export function parsePrice(text: string): { amount: string; currency: string | null; period: PriceRow["period"] } | null {
  // "$0 for 3 months, then $12.99 per month": the price that matters is the last one in the line
  const all = [...text.matchAll(/(?:(CA\$|US\$|C\$|A\$|\$|€|£|¥|₹|CHF|zł|kr)\s?(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d{1,6}(?:[.,]\d{1,2})?))|(?:(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d{1,6}(?:[.,]\d{1,2})?)\s?(€|EUR|USD|CAD|GBP|CHF|kr|zł))/g)];
  const m = all.at(-1);
  if (!m) return null;
  const rawAmount = m[2] ?? m[3];
  const symbol = m[1] ?? m[4];
  // "12,99" is a decimal comma when there are exactly two digits after it
  const amount = /,\d{3}(\.\d+)?$/.test(rawAmount) ? rawAmount.replace(/,/g, "") : /,\d{2}$/.test(rawAmount) ? rawAmount.replace(",", ".") : rawAmount;
  const currency = SYMBOLS.find(([re]) => re.test(symbol))?.[1] ?? null;
  const p = text.toLowerCase();
  const period: PriceRow["period"] = /\/\s?(mo|month|monat|mois)|per month|pro monat|monthly|a month/.test(p) ? "month"
    : /\/\s?(yr|year|jahr|an)|per year|pro jahr|annually|yearly|a year/.test(p) ? "year"
    : /\/\s?(wk|week)|per week|weekly/.test(p) ? "week"
    : /\/\s?day|per day|daily/.test(p) ? "day" : null;
  return { amount, currency, period };
}

/** One row per observation that reads as a price. Layers surface, hidden and borders all count. */
export function priceRows(observations: Observation[]): PriceRow[] {
  const rows: PriceRow[] = [];
  const seen = new Set<string>();
  for (const o of observations) {
    if (!PRICE.test(o.text)) continue;
    const parsed = parsePrice(o.text);
    if (!parsed) continue;
    const key = `${o.url}|${vantageKey(o)}|${parsed.amount}|${parsed.currency}|${parsed.period}|${o.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ url: o.url, country: o.vantage.country, device: o.vantage.device, vantage: vantageKey(o), ...parsed, text: o.text, observationId: o.id, layer: o.layer });
  }
  return rows.sort((a, b) => a.url.localeCompare(b.url) || a.vantage.localeCompare(b.vantage) || Number(a.amount) - Number(b.amount));
}

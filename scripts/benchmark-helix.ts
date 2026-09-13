// Material-coverage benchmark on the team's test SaaS (Helix Ledger): what does each research approach actually
// deliver to the model? Scored against benchmarks/helix-rubric.json (65 planted facts).
//
//   npx tsx scripts/benchmark-helix.ts --base http://localhost:3000 --parallel-dir <dir with parallel-*.txt> [--model]
//
// Conditions:
//   fetch      a plain HTTP GET of each public page, stripped to visible text (what a model with a fetch tool receives)
//   parallel   the full-content markdown a hosted reader connector returned for the same pages (files captured beforehand)
//   periscope  Periscope's parsers in a local Chromium: the deterministic reveal on every public page, then the signed-in
//              walker after a human-style login with the seeded demo account (fixture credentials from the app's README)
// --model adds a second score per condition: Claude Opus 4.8 reads the material and reports which rubric items it found.
// Only what the material contains can be reported, so the material score is the ceiling and the model score the realism.
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { chromium, type Page } from "playwright-core";
import { htmlToText } from "../src/benchmark.js";
import { revealDeterministic, visibleLines } from "../src/reveal-deterministic.js";
import { walkDeterministic } from "../src/walker-deterministic.js";
import { anthropicComplete } from "../src/intel/extract.js";
import type { EventSink, SessionHandle } from "@periscope/contracts";

interface RubricItem { id: string; group: string; label: string; accept: string[]; all?: boolean }
interface Rubric { title: string; items: RubricItem[] }

function arg(name: string, fallback?: string): string | undefined { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : fallback; }
const base = (arg("base", "http://localhost:3000") as string).replace(/\/$/, "");
const parallelDir = arg("parallel-dir");
const useModel = process.argv.includes("--model") && Boolean(process.env.ANTHROPIC_API_KEY);
const PUBLIC_PAGES = ["/", "/pricing", "/regulatory", "/security", "/sign-in"];
const norm = (s: string) => s.toLowerCase().replace(/[\u2019']/g, "'").replace(/\s+/g, " ").trim();

const rubric = JSON.parse(readFileSync(path.join("benchmarks", "helix-rubric.json"), "utf8")) as Rubric;

function score(material: string): Set<string> {
  const m = norm(material);
  const hit = new Set<string>();
  for (const it of rubric.items) {
    const ok = it.all ? it.accept.every((a) => m.includes(norm(a))) : it.accept.some((a) => m.includes(norm(a)));
    if (ok) hit.add(it.id);
  }
  return hit;
}

async function conditionFetch(): Promise<string> {
  const parts: string[] = [];
  for (const p of [...PUBLIC_PAGES, "/dashboard"]) {
    try { const r = await fetch(base + p, { redirect: "follow" }); parts.push(`## ${p}\n${htmlToText(await r.text())}`); } catch (e) { parts.push(`## ${p}\n(fetch failed: ${(e as Error).message})`); }
  }
  return parts.join("\n\n");
}

function conditionParallel(): string {
  if (!parallelDir || !existsSync(parallelDir)) return "";
  return readdirSync(parallelDir).filter((f) => f.startsWith("parallel-") && f.endsWith(".txt")).map((f) => `## ${f}\n${readFileSync(path.join(parallelDir, f), "utf8")}`).join("\n\n");
}

const sink: EventSink = { async write() {} };
function handleFor(page: Page): SessionHandle {
  return { sessionId: "local", viewerUrl: "", cdpUrl: "", vantage: { country: null, device: "desktop", authenticated: false }, page, deadlineAt: new Date(Date.now() + 20 * 60_000).toISOString(), async release() {}, async checkpoint() {} };
}

async function conditionPeriscope(): Promise<{ material: string; stats: Record<string, number> }> {
  const executablePath = process.env.PERISCOPE_CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
  const browser = await chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage();
  const parts: string[] = [];
  const stats: Record<string, number> = { surfaceLines: 0, hidden: 0, interior: 0, screens: 0 };
  try {
    for (const p of PUBLIC_PAGES) {
      const url = base + p;
      await page.goto(url, { waitUntil: "load" });
      const surface = await visibleLines(page);
      stats.surfaceLines += surface.length;
      const res = await revealDeterministic({ runId: "bench", jobId: `reveal${p}`, competitor: "helix", url, surfaceBaseline: surface.join("\n"), page, handle: handleFor(page), sink });
      stats.hidden += res.observations.length;
      parts.push(`## ${p} (surface)\n${surface.join("\n")}\n## ${p} (revealed)\n${res.observations.map((o) => o.text).join("\n")}`);
    }
    // Login beat, the way a teammate does it in Steel's live view: the seeded demo account from the app's README.
    await page.goto(base + "/sign-in", { waitUntil: "load" });
    await page.fill("input[name=email]", process.env.HELIX_EMAIL ?? "test@test.com");
    await page.fill("input[name=password]", process.env.HELIX_PASSWORD ?? "admin123");
    await page.waitForSelector("altcha-widget input[type=checkbox]", { timeout: 20_000 }).catch(() => undefined);
    const box = page.locator("altcha-widget label").first();
    if (await box.count()) { await box.click({ force: true }); await page.waitForFunction(() => (document.querySelector('input[name="altcha"]') as HTMLInputElement | null)?.value, undefined, { timeout: 30_000 }).catch(() => undefined); }
    await page.click("button[type=submit]");
    await page.waitForURL(/\/dashboard/, { timeout: 30_000 }).catch(() => undefined);
    const signedIn = /\/dashboard/.test(page.url());
    if (signedIn) {
      const walk = await walkDeterministic({ runId: "bench", jobId: "walk", competitor: "helix", startUrl: base + "/dashboard", page, handle: { ...handleFor(page), vantage: { country: null, device: "desktop", authenticated: true } }, sink, maxScreens: 20 });
      const lines = [...walk.screens.values()].flatMap((s) => s.observations.map((o) => o.text));
      stats.interior += lines.length; stats.screens = walk.screens.size;
      parts.push(`## signed-in walk (${walk.screens.size} screens, ${walk.stoppedReason})\n${lines.join("\n")}`);
    } else {
      parts.push("## signed-in walk\n(login did not complete)");
    }
  } finally { await browser.close(); }
  return { material: parts.join("\n\n"), stats };
}

async function modelReport(material: string): Promise<Set<string>> {
  const complete = anthropicComplete("claude-opus-4-8");
  const schema = { type: "object", properties: { found: { type: "array", items: { type: "string" } } }, required: ["found"] };
  const list = rubric.items.map((i) => `${i.id}: ${i.group} — ${i.label}`).join("\n");
  const { input } = await complete({
    system: "You are a competitive-research analyst. You are given the material a research tool returned about a SaaS product and a checklist of facts. Report the ids of every checklist item whose exact fact is present in the material. Do not guess, do not infer from general knowledge; only what the text shows.",
    user: `Checklist:\n${list}\n\nMaterial:\n${material.slice(0, 120_000)}`,
    toolName: "report_found", schema, maxTokens: 2000,
  });
  const found = new Set<string>(((input as { found?: unknown }).found as string[] | undefined) ?? []);
  const truth = score(material);
  return new Set([...found].filter((id) => truth.has(id))); // only credit items the material really contains
}

function table(rows: Array<{ name: string; hits: Set<string>; model?: Set<string> }>): string {
  const groups = [...new Set(rubric.items.map((i) => i.group))];
  const head = `| Group | Items | ${rows.map((r) => r.name + (r.model ? " (material / Opus 4.8)" : "")).join(" | ")} |`;
  const sep = `|---|---|${rows.map(() => "---").join("|")}|`;
  const lines = groups.map((g) => {
    const ids = rubric.items.filter((i) => i.group === g).map((i) => i.id);
    return `| ${g} | ${ids.length} | ${rows.map((r) => { const a = ids.filter((id) => r.hits.has(id)).length; const b = r.model ? ids.filter((id) => r.model!.has(id)).length : undefined; return b === undefined ? String(a) : `${a} / ${b}`; }).join(" | ")} |`;
  });
  const total = `| **Total** | **${rubric.items.length}** | ${rows.map((r) => r.model ? `**${r.hits.size} / ${r.model.size}**` : `**${r.hits.size}**`).join(" | ")} |`;
  return [head, sep, ...lines, total].join("\n");
}

const t0 = Date.now();
const results: Array<{ name: string; hits: Set<string>; model?: Set<string>; material: string; seconds: number; stats?: Record<string, number> }> = [];
let t = Date.now(); const fetchMat = await conditionFetch(); results.push({ name: "Claude Opus 4.8 + fetch", hits: score(fetchMat), material: fetchMat, seconds: (Date.now() - t) / 1000 });
t = Date.now(); const parMat = conditionParallel(); if (parMat) results.push({ name: "Claude Opus + Parallel connector", hits: score(parMat), material: parMat, seconds: (Date.now() - t) / 1000 });
t = Date.now(); const peri = await conditionPeriscope(); results.push({ name: "Periscope", hits: score(peri.material), material: peri.material, seconds: (Date.now() - t) / 1000, stats: peri.stats });
if (useModel) for (const r of results) r.model = await modelReport(r.material);

const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
mkdirSync("benchmarks", { recursive: true });
const md = [
  `# Helix Ledger benchmark, ${new Date().toISOString().slice(0, 10)}`,
  ``,
  `Target: ${base}. Rubric: ${rubric.items.length} planted facts (benchmarks/helix-rubric.json). Score = facts present in the material each approach delivers to the model${useModel ? "; second number = what Claude Opus 4.8 reported after reading that material" : ""}.`,
  ``,
  table(results),
  ``,
  `| Condition | Seconds | Notes |`, `|---|---|---|`,
  ...results.map((r) => `| ${r.name} | ${r.seconds.toFixed(0)} | ${r.stats ? `surface ${r.stats.surfaceLines} lines, revealed ${r.stats.hidden}, interior ${r.stats.interior} lines over ${r.stats.screens} screens` : `${r.material.split("\n").length} lines of material`} |`),
  ``,
  `## Missed by condition`,
  ...results.map((r) => `\n### ${r.name}\n${rubric.items.filter((i) => !r.hits.has(i.id)).map((i) => `- ${i.group}: ${i.label}`).join("\n") || "- nothing missed"}`),
  ``,
  `## Method`,
  `- fetch: HTTP GET of ${PUBLIC_PAGES.join(", ")} and /dashboard, HTML stripped to text (the app is client-rendered, so hidden states never appear).`,
  `- Parallel connector: full-content markdown from the hosted reader for the same public pages, captured with the connector's own tool.`,
  `- Periscope: deterministic reveal (toggles, dropdowns, accordions, hover, show more, iframes, page-load API calls) on every public page, then the walker behind the login. Login performed the way a teammate does it in Steel's live view, with the app's seeded demo account. Local Chromium; the same code runs on Steel in the demo.`,
  `- Matching: case-insensitive substring of the planted text; integration statuses need both the name and the status present.`,
].join("\n");
writeFileSync(path.join("benchmarks", `results-${stamp}.md`), md);
writeFileSync(path.join("benchmarks", `results-${stamp}.json`), JSON.stringify({ base, results: results.map((r) => ({ name: r.name, score: r.hits.size, model: r.model ? r.model.size : undefined, hits: [...r.hits], seconds: r.seconds, stats: r.stats })) }, null, 2));
writeFileSync(path.join("benchmarks", `material-${stamp}.md`), results.map((r) => `# ${r.name}\n\n${r.material}`).join("\n\n\n"));
console.log(md);
console.log(`\nwritten benchmarks/results-${stamp}.md in ${Math.round((Date.now() - t0) / 1000)}s`);

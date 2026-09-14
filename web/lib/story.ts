// Plain-language derivations for the console: the Steel usage trace (which browsers opened, where, with what) and
// one story per run (what the agent did, with every Steel feature named). Ported from the Streamlit live section.
import { countryName, type Handoff, type LiveSession, type RunView, type StoredEvent } from "./api";

export type TraceLine = { at: string; kind: "steel" | "release" | "wall"; text: string };
export type SteelStats = { browsers: number; countries: Set<string>; devices: Set<string>; logins: number; walls: number; captcha: number };
export type TraceState = { seen: Map<string, { t: number; purpose?: string; closed?: boolean }>; trace: TraceLine[]; stats: SteelStats };

export const newTraceState = (): TraceState => ({ seen: new Map(), trace: [], stats: { browsers: 0, countries: new Set(), devices: new Set(), logins: 0, walls: 0, captcha: 0 } });

const now = () => new Date().toISOString().slice(11, 19);
const PRICE = /(\$|€|£|CA\$)\s?\d|\d+([.,]\d+)?\s?(€|EUR)/;

/** Update the trace with the current live sessions and pending handoffs. Mutates and returns the state. */
export function updateTrace(state: TraceState, sessions: LiveSession[], handoffs: Handoff[]): TraceState {
  const live = new Set(sessions.map((s) => s.sessionId));
  for (const s of sessions) {
    if (state.seen.has(s.sessionId)) continue;
    state.seen.set(s.sessionId, { t: Date.now(), purpose: s.purpose });
    state.stats.browsers += 1;
    state.stats.devices.add(s.vantage.device);
    if (s.vantage.country) state.stats.countries.add(s.vantage.country);
    const parts = [
      `Steel opened browser #${state.stats.browsers} for ${s.competitor ?? "a target"}`,
      `purpose ${s.purpose ?? "session"}`,
      s.vantage.country ? `${countryName(s.vantage.country)} through a Steel proxy` : "Steel's home region",
      s.vantage.device === "mobile" ? "mobile device emulation" : "desktop",
    ];
    if (s.accountRef) { parts.push("saved login: Steel profile restored and credentials injected, never seen by the model"); state.stats.logins += 1; }
    else if (s.purpose === "walker") parts.push("Steel keeps this session's profile so the login survives for later walks");
    state.trace.push({ at: now(), kind: "steel", text: `${parts.join(" · ")} · session ${s.sessionId.slice(0, 8)}` });
  }
  for (const [id, info] of state.seen) {
    if (!live.has(id) && !info.closed && !id.includes(":")) {
      info.closed = true;
      state.trace.push({ at: now(), kind: "release", text: `Steel released browser ${id.slice(0, 8)} after ${Math.round((Date.now() - info.t) / 1000)} s (${info.purpose ?? "session"})` });
    }
  }
  for (const h of handoffs) {
    const key = `${h.jobId}:${h.generation}`;
    if (!state.seen.has(key)) {
      state.seen.set(key, { t: Date.now(), closed: true });
      state.stats.walls += 1;
      state.trace.push({ at: now(), kind: "wall", text: `${h.wall.toUpperCase()} wall: the session is kept alive, a human takes over in Steel's live view, the walk resumes in the same browser` });
    }
  }
  return state;
}

export type StoryKind = "PARSE" | "COUNTRIES" | "LOG IN";
export type StoryLine = { tone: "plain" | "ok" | "warn" | "muted"; html: string };
export type Story = { runId: string; kind: StoryKind; competitor: string; status: string; badges: string[]; lines: StoryLine[]; seconds: number | null };

type Obs = { layer?: string; text?: string; url?: string; missedByFetch?: boolean; kind?: string; revealedBy?: { action?: string; label?: string }; vantage?: { country?: string | null; device?: string } };
const VERBS: Record<string, string> = { toggle: "flipped", click: "opened", select: "selected", hover: "hovered", scroll: "scrolled to", none: "read" };
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function storyFor(run: RunView, events: StoredEvent[]): Story {
  const purposes = new Set(run.jobs.map((j) => j.purpose));
  const kind: StoryKind = purposes.has("walker") ? "LOG IN" : purposes.has("borders") ? "COUNTRIES" : "PARSE";
  const status = run.run.status;
  const obs = events.filter((e) => e.type === "observation").map((e) => e.event.data as Obs);
  const hidden = obs.filter((o) => o.layer === "hidden");
  const borders = obs.filter((o) => o.layer === "borders");
  const interior = obs.filter((o) => o.layer === "interior" && o.kind !== "screen");
  const countries = [...new Set(obs.map((o) => o.vantage?.country).filter((c): c is string => Boolean(c)))].sort();
  const devices = new Set(obs.map((o) => o.vantage?.device ?? "desktop"));
  const counters = new Map<string, number>();
  for (const e of events) if (e.type === "counter") { const d = e.event.data as { url: string; missed: unknown }; if (typeof d.missed === "number") counters.set(d.url, Math.max(counters.get(d.url) ?? 0, d.missed)); }
  const handoffs = events.filter((e) => e.type === "handoff").map((e) => e.event.data as { wall: string; state: string });
  const reasons = events.filter((e) => e.type === "job_state").map((e) => String((e.event.data as { reason?: string }).reason ?? ""));
  const captcha = reasons.filter((r) => r.includes("captcha")).map((r) => r.split(":").pop() ?? "");
  const logins = reasons.filter((r) => r.startsWith("login:"));
  const attempts = reasons.filter((r) => r.startsWith("login attempt:"));
  let seconds: number | null = null;
  try { seconds = Math.round((new Date(run.run.updatedAt).getTime() - new Date(run.run.createdAt).getTime()) / 1000); } catch { /* none */ }

  const badges = [kind === "COUNTRIES" ? "6 Steel browsers" : "1 Steel browser"];
  if (countries.length) badges.push(`Steel proxies: ${countries.join(" ")}`);
  if (devices.has("mobile")) badges.push("device emulation");
  if (kind === "LOG IN") badges.push("profile kept");
  if (captcha.length) badges.push("CAPTCHA solver");
  if (handoffs.length) badges.push("live view handoff");
  if (logins.length || attempts.length) badges.push("credentials vault");

  const lines: StoryLine[] = [];
  if (kind === "PARSE") {
    const byLabel = new Map<string, { n: number; action: string }>();
    for (const o of hidden) {
      if (!o.missedByFetch) continue;
      const label = o.revealedBy?.label || o.revealedBy?.action || "page";
      const cur = byLabel.get(label) ?? { n: 0, action: o.revealedBy?.action ?? "click" };
      cur.n += 1; byLabel.set(label, cur);
    }
    for (const [label, v] of [...byLabel.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 5)) {
      lines.push({ tone: "plain", html: `${VERBS[v.action] ?? "used"} <b>${esc(label.slice(0, 40))}</b> → ${v.n} line${v.n === 1 ? "" : "s"} a fetch tool never saw` });
    }
    const total = [...counters.values()].reduce((a, b) => a + b, 0);
    if (total) lines.push({ tone: "ok", html: `${total} lines missed by fetch across ${counters.size} page${counters.size === 1 ? "" : "s"}${seconds !== null ? ` · ${seconds} s` : ""}` });
    else if (status === "running") lines.push({ tone: "muted", html: "reading the page, then clicking everything a fetch tool cannot" });
    else lines.push({ tone: "muted", html: "this run did not finish its reveal; press the button again with nothing else running" });
  } else if (kind === "COUNTRIES") {
    const byCountry = new Map<string, string[]>();
    for (const o of borders) {
      const c = o.vantage?.country; const t = o.text ?? "";
      if (!c || !PRICE.test(t)) continue;
      const list = byCountry.get(c) ?? [];
      if (!list.includes(t) && list.length < 3) list.push(t);
      byCountry.set(c, list);
    }
    for (const [c, prices] of byCountry) lines.push({ tone: "plain", html: `from <b>${esc(countryName(c) ?? c)}</b> through a Steel proxy: ${prices.map((p) => esc(p.slice(0, 26))).join(" · ")}` });
    if (byCountry.size > 1) lines.push({ tone: "ok", html: `prices differ by country, seen in ${borders.length} lines from 6 browsers at once${seconds !== null ? ` · ${seconds} s` : ""}` });
    else if (status === "running") lines.push({ tone: "muted", html: "opening six browsers in three countries" });
  } else {
    if (logins.length) lines.push({ tone: "ok", html: "Steel injected the stored credentials from its vault, the anti-bot box was verified in the browser, <b>signed in without a human</b>. The model never saw the password." });
    else if (attempts.length) lines.push({ tone: "warn", html: `${esc(attempts[attempts.length - 1].replace("login attempt: ", "").replace("; handing off to a human", ""))}, so a human takes over in the live view` });
    if (handoffs.length) {
      const last = handoffs[handoffs.length - 1];
      const msg: Record<string, string> = { awaiting_human: "waiting for a human in Steel's live view", resumed: "a human cleared it, the walk resumed in the same browser", abandoned: "nobody cleared it in time" };
      lines.push({ tone: "warn", html: `${esc(last.wall)} wall → ${msg[last.state] ?? esc(last.state)}` });
    }
    if (captcha.length) lines.push({ tone: "plain", html: `Steel CAPTCHA solver ran first: <b>${esc(captcha[captcha.length - 1])}</b>` });
    if (interior.length) {
      const pages = [...new Set(interior.map((o) => (o.url ?? "").replace(/\/$/, "").split("/").pop() || "dashboard"))].sort();
      lines.push({ tone: "ok", html: `inside: ${interior.length} facts from ${pages.length} screens (${esc(pages.slice(0, 6).join(", "))})` });
      for (const o of interior.slice(0, 3)) lines.push({ tone: "muted", html: esc((o.text ?? "").slice(0, 90)) });
    }
    if (!handoffs.length && !interior.length && !logins.length) lines.push({ tone: "muted", html: "opening the sign-in page" });
  }
  return { runId: run.run.id, kind, competitor: run.jobs[0]?.competitor ?? "", status, badges, lines, seconds };
}

export const storyOrder = (id: string) => ({ parse: 0, borders: 1, login: 2 } as Record<string, number>)[id.split("-")[1] ?? ""] ?? 9;

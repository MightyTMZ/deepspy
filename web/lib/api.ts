// Periscope API client for the console. Every number on the page comes from these routes (docs/api.md).
// The site is a static export, so all calls are made from the browser; the API answers with CORS headers.
"use client";
import { useEffect, useRef, useState } from "react";

export const API_BASE = (process.env.NEXT_PUBLIC_PERISCOPE_API_URL || "http://localhost:4747").replace(/\/$/, "");
const API_KEY = "periscope.api";
let apiBase = API_BASE;

/** The address the page talks to right now. Changeable at runtime, so a hosted page can point at a tunnel in front of a local API. */
export const getApiBase = () => apiBase;
export function setApiBase(url: string): string {
  const next = url.trim().replace(/\/$/, "");
  apiBase = /^https?:\/\//i.test(next) ? next : API_BASE;
  try { if (apiBase === API_BASE) localStorage.removeItem(API_KEY); else localStorage.setItem(API_KEY, apiBase); } catch { /* storage unavailable */ }
  return apiBase;
}
/** Resolve the address once on mount: `?api=` in the url wins, then the one saved in this browser, then the build default. */
export function initApiBase(): string {
  try {
    const fromQuery = new URLSearchParams(window.location.search).get("api");
    if (fromQuery) return setApiBase(fromQuery);
    const saved = localStorage.getItem(API_KEY);
    if (saved) apiBase = saved;
  } catch { /* no window or storage */ }
  return apiBase;
}
export const TARGET_URL = (process.env.NEXT_PUBLIC_PERISCOPE_TARGET_URL || "https://testsaasstartup.vercel.app").replace(/\/$/, "");
export const TARGET_EMAIL = process.env.NEXT_PUBLIC_PERISCOPE_TARGET_EMAIL || "test@test.com";

export type Vantage = { country: string | null; device: "desktop" | "mobile"; authenticated: boolean };
export type LiveSession = {
  sessionId: string; viewerUrl: string; playerUrl: string; purpose?: string; vantage: Vantage;
  accountRef?: string; profileId?: string; startedAt?: string; deadlineAt: string; currentUrl: string | null;
  runId?: string; competitor?: string; pendingWall: string | null;
};
export type Handoff = { jobId: string; viewerUrl: string; wall: string; generation: number; state: string };
export type RunSummary = { id: string; status: string; spentUsd: number; capUsd: number; live: boolean; observations: number; competitors: string[]; purposes?: string[]; createdAt: string; updatedAt: string };
export type RunView = {
  ok: boolean;
  run: { id: string; status: string; createdAt: string; updatedAt: string; spentUsd: number; capUsd: number; live: boolean };
  jobs: Array<{ id: string; purpose: string; competitor: string | null; url: string | null; state: string; reason: string | null }>;
  counts: { observations: number; events: number; handoffs: number };
  counters: Array<{ competitor: string; url: string; missed: number | "uncertain" }>;
};
export type StoredEvent = { eventId: number; runId: string; jobId: string | null; type: string; createdAt: string; event: { type: string; data: Record<string, unknown> } };
export type CoveragePage = { url: string; surface: number; hidden: number; missedByFetch: number; documents: number; vantages: string[]; byAction: Record<string, number>; counter: number | "uncertain" };
export type BordersGrid = { url: string; shared: number; differsByCountry: boolean; differsByDevice: boolean; countries: Array<{ country: string; uniqueToCountry: string[]; prices: string[] }> };
export type PriceRow = { url: string; country: string | null; device: string; vantage: string; amount: string; currency: string | null; period: string | null; text: string; observationId: string; layer: string };
export type MatrixRow = { id: string; competitor: string; feature: string; status: string; value: string | null; evidence: string[] };

export async function apiGet<T>(path: string): Promise<T | null> {
  try {
    const r = await fetch(apiBase + path, { cache: "no-store" });
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

export async function apiPost<T>(path: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: T | null }> {
  try {
    const r = await fetch(apiBase + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    return { status: r.status, body: (await r.json().catch(() => null)) as T | null };
  } catch {
    return { status: 0, body: null };
  }
}

/** Poll a loader on an interval; the value stays until the next successful load. */
export function usePoll<T>(load: () => Promise<T | null>, intervalMs: number, deps: unknown[] = []): T | null {
  const [value, setValue] = useState<T | null>(null);
  const loader = useRef(load);
  loader.current = load;
  useEffect(() => {
    let cancelled = false;
    const tick = async () => { const v = await loader.current(); if (!cancelled && v !== null) setValue(v); };
    void tick();
    const id = setInterval(tick, intervalMs);
    return () => { cancelled = true; clearInterval(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalMs, ...deps]);
  return value;
}

export const COUNTRY_NAMES: Record<string, string> = { CA: "Canada", US: "United States", DE: "Germany", GB: "United Kingdom", FR: "France", JP: "Japan", AU: "Australia", IN: "India", BR: "Brazil" };
export const countryName = (c?: string | null) => (c ? COUNTRY_NAMES[c] ?? c : null);

/** The Helix Ledger demo: parse the pricing page, see it from three countries, sign in with the vaulted account. */
export async function launchHelixDemo(target: string): Promise<{ launched: string[]; errors: string[] }> {
  const stamp = new Date().toISOString().slice(11, 19).replace(/:/g, "");
  const bodies = [
    { competitor: "helix-ledger", url: target, pages: ["/pricing", "/regulatory", "/security"], jobs: ["surface", "benchmark", "reveal"], runId: `helix-parse-${stamp}` },
    { competitor: "helix-ledger", url: target, pages: ["/pricing"], jobs: ["surface", "borders"], countries: ["CA", "US", "DE"], runId: `helix-borders-${stamp}` },
    // accountRef trial1: Steel injects the credential stored in its vault; no proxy, the tunnel challenges proxied traffic
    { competitor: "helix-ledger", url: target, jobs: ["walker"], start: `${target}/sign-in`, countries: [], accountRef: "trial1", runId: `helix-login-${stamp}` },
  ];
  const launched: string[] = []; const errors: string[] = [];
  for (const body of bodies) {
    const { status, body: res } = await apiPost<{ ok: boolean; runId?: string; reason?: string }>("/runs", body, { "Idempotency-Key": `web-${body.runId}` });
    if (res?.ok && res.runId) launched.push(res.runId); else errors.push(`${body.runId}: ${res?.reason ?? `HTTP ${status}`}`);
  }
  return { launched, errors };
}

/** A single custom run against any url: surface, benchmark, reveal and borders. */
export async function launchCustomRun(url: string): Promise<{ runId?: string; error?: string }> {
  const u = new URL(url);
  const { status, body } = await apiPost<{ ok: boolean; runId?: string; reason?: string }>("/runs", {
    competitor: u.hostname.replace(/^www\./, ""), url: u.origin, pages: [u.pathname || "/"], jobs: ["surface", "benchmark", "reveal", "borders"], countries: ["CA", "US", "DE"], category: "demo",
  }, { "Idempotency-Key": `web-${Date.now()}` });
  return body?.ok && body.runId ? { runId: body.runId } : { error: body?.reason ?? (status === 0 ? "API unavailable. Start npm run api on port 4747." : `HTTP ${status}`) };
}

"use client";
// The centre of the console: every Steel browser the agents hold, embedded live; the Steel usage trace; walls with a
// resume button; one story per run; and the intelligence beneath. Mirrors the Streamlit live section, against the same API.
import { useEffect, useMemo, useRef, useState } from "react";
import {
  apiGet, apiPost, countryName, initApiBase, launchCustomRun, launchHelixDemo, setApiBase, TARGET_EMAIL, TARGET_URL, usePoll,
  type BordersGrid, type CoveragePage, type Handoff, type LiveSession, type MatrixRow, type PriceRow, type RunSummary, type RunView, type StoredEvent,
} from "@/lib/api";
import { newTraceState, storyFor, storyOrder, updateTrace, type Story, type TraceState } from "@/lib/story";

type Health = { ok: boolean; steel: boolean; model: boolean };

export function LiveSection({ onConnection }: { onConnection?: (connected: boolean) => void }) {
  // The API address: build default, or whatever was pasted into the page (kept in this browser), or `?api=` in the url.
  const [api, setApi] = useState("");
  const [apiDraft, setApiDraft] = useState("");
  useEffect(() => { const b = initApiBase(); setApi(b); setApiDraft(b); }, []);
  const [hosted, setHosted] = useState(false);
  useEffect(() => { setHosted(window.location.protocol === "https:"); }, []);

  const health = usePoll(() => apiGet<Health>("/health"), 5000, [api]);
  const connected = Boolean(health?.ok);
  useEffect(() => { onConnection?.(connected); }, [connected, onConnection]);

  const sessions = usePoll(() => apiGet<{ sessions: LiveSession[] }>("/sessions").then((r) => r?.sessions ?? null), 2000, [api]);
  const handoffs = usePoll(() => apiGet<{ handoffs: Handoff[] }>("/handoffs").then((r) => r?.handoffs ?? null), 2000, [api]);
  const runs = usePoll(() => apiGet<{ runs: RunSummary[] }>("/runs?limit=30").then((r) => r?.runs ?? null), 4000, [api]);
  function connect(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const next = setApiBase(apiDraft);
    setApi(next); setApiDraft(next);
  }

  const [target, setTarget] = useState(TARGET_URL);
  const [custom, setCustom] = useState("");
  const [followed, setFollowed] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  // Default to the latest Helix runs so the page is never empty.
  const followedRuns = useMemo(() => {
    if (followed.length) return followed;
    return (runs ?? []).filter((r) => r.competitors.includes("helix-ledger")).slice(0, 3).map((r) => r.id);
  }, [followed, runs]);

  // Steel usage trace, accumulated across polls.
  const traceRef = useRef<TraceState>(newTraceState());
  const [traceVersion, setTraceVersion] = useState(0);
  useEffect(() => {
    if (!sessions || !handoffs) return;
    updateTrace(traceRef.current, sessions, handoffs);
    setTraceVersion((v) => v + 1);
  }, [sessions, handoffs]);
  const { trace, stats } = traceRef.current;
  void traceVersion;

  async function runHelix() {
    if (busy) return;
    setBusy(true); setNote("Launching three runs on Steel…");
    const { launched, errors } = await launchHelixDemo(target.replace(/\/$/, ""));
    if (launched.length) { setFollowed(launched); setNote(`Launched ${launched.length} run${launched.length === 1 ? "" : "s"}: ${launched.join(", ")}`); }
    if (errors.length) setNote((n) => `${n}${n ? " · " : ""}${errors.join(" · ")}`);
    setBusy(false);
  }
  async function runCustom(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!/^https?:\/\//i.test(custom.trim())) { setNote("Enter a full url starting with https://"); return; }
    setBusy(true); setNote("Launching…");
    const r = await launchCustomRun(custom.trim());
    setNote(r.runId ? `Run ${r.runId} launched.` : r.error ?? "Launch failed.");
    if (r.runId) setFollowed([r.runId]);
    setBusy(false);
  }
  async function resume(h: Handoff) {
    const { body } = await apiPost<{ ok: boolean; reason?: string }>(`/jobs/${h.jobId}/resume`, { generation: h.generation });
    setNote(body?.ok ? `Resumed job ${h.jobId.slice(0, 8)}.` : body?.reason ?? "Resume refused.");
  }

  const disabled = !/^https?:\/\//i.test(target) || /localhost|127\.0\.0\.1/.test(target) || !health?.steel;
  const live = sessions ?? [];
  const cols = live.length >= 5 ? 3 : live.length > 1 ? 2 : 1;

  return (
    <section id="live" className="console-section live-section" aria-labelledby="live-title">
      <div className="console-section-title">
        <div>
          <div className="eyebrow">01 / LIVE · THE AGENTS AT WORK ON STEEL</div>
          <h2 id="live-title">Watch the browsers.<br /><span className="muted">Follow the evidence.</span></h2>
        </div>
        <p>Every frame is a real Steel browser, streamed as it runs. One parses the pricing page, six see it from three countries through Steel proxies, one walks in past the login. The trace names every Steel feature as it is used.</p>
      </div>

      <div className="launcher">
        <form className="launcher-row api-row" onSubmit={connect}>
          <label className="mono" htmlFor="api-url">PERISCOPE API · EVERY NUMBER ON THIS PAGE COMES FROM THIS ADDRESS</label>
          <div>
            <input id="api-url" type="url" value={apiDraft} onChange={(e) => setApiDraft(e.target.value)} placeholder="http://localhost:4747" />
            <button type="submit" className="secondary-action">Connect</button>
          </div>
          <p>{connected
            ? `Connected to ${api} · Steel ${health?.steel ? "on" : "off"} · model ${health?.model ? "on" : "off"}`
            : hosted && /^http:\/\/(localhost|127\.0\.0\.1)/.test(api)
              ? "This page is served over https, so the browser will not let it call an API on localhost. Start the API on your machine (npm run api, port 4747), expose it with npx cloudflared tunnel --url http://localhost:4747, paste the https address it prints here and press Connect."
              : `Not reachable at ${api || "the default address"}. Start the API with npm run api, or paste its public address here.`}</p>
        </form>
        <div className="launcher-row">
          <label className="mono" htmlFor="helix-target">TARGET · HELIX LEDGER, THE TEAM&apos;S TEST SAAS</label>
          <div>
            <input id="helix-target" type="url" value={target} onChange={(e) => setTarget(e.target.value)} placeholder="https://testsaasstartup.vercel.app" />
            <button type="button" className="primary-action" disabled={disabled || busy} onClick={runHelix}>Run the Helix Ledger demo: parse, three countries, log in</button>
          </div>
          <p>Login beat: Steel injects the vaulted credential for {TARGET_EMAIL}, the walker clears the anti-bot box and signs in. If that fails, the wall card turns red and a person finishes it in the live frame. {health && !health.steel ? "The API has no Steel key, so nothing can be launched." : ""}</p>
        </div>
        <form className="launcher-row" onSubmit={runCustom}>
          <label className="mono" htmlFor="custom-target">ANY OTHER URL · SURFACE, BENCHMARK, REVEAL, BORDERS</label>
          <div>
            <input id="custom-target" type="url" value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="https://competitor.example/pricing" />
            <button type="submit" className="secondary-action" disabled={busy || !health?.steel}>Open with Steel</button>
          </div>
          <p>{note || (connected ? "One run: surface, benchmark, reveal and borders from CA, US and DE." : "Connect the API above first.")}</p>
        </form>
      </div>

      <div className="chips mono" aria-label="Steel usage so far">
        <span><b>{stats.browsers}</b> Steel browsers opened</span>
        <span><b>{stats.countries.size}</b> countries via Steel proxies{stats.countries.size ? ` (${[...stats.countries].sort().join(", ")})` : ""}</span>
        <span><b>{stats.devices.size}</b> device profiles</span>
        <span><b>{stats.walls}</b> human handoffs</span>
        <span><b>{live.length}</b> live now</span>
      </div>

      <div className="live-layout">
        <div className="browser-wall">
          {live.length === 0 && <div className="empty-state mono">NO STEEL BROWSER OPEN RIGHT NOW · PRESS THE BUTTON; BROWSERS APPEAR WITHIN SECONDS</div>}
          <div className="browser-grid" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
            {live.map((s) => (
              <figure key={s.sessionId} className="browser-frame">
                <figcaption className="mono">
                  <strong>{s.competitor ?? ""}</strong>
                  <span className="tag">{s.purpose ?? "session"}</span>
                  <span className="tag steel">{s.vantage.country ? `${countryName(s.vantage.country)} · proxy` : "home region"}</span>
                  <span className="tag">{s.vantage.device}</span>
                  {s.accountRef && <span className="tag ok">signed in</span>}
                  {s.pendingWall && <span className="tag warn">wall: {s.pendingWall} · needs a human</span>}
                  <small>{(s.currentUrl ?? "").slice(0, 80)}</small>
                </figcaption>
                <iframe title={`Steel session ${s.sessionId}`} src={s.playerUrl} allow="clipboard-read; clipboard-write" referrerPolicy="no-referrer" />
                <div className="frame-foot mono">Steel session {s.sessionId.slice(0, 8)} · <a href={s.viewerUrl} target="_blank" rel="noreferrer">open in Steel</a></div>
              </figure>
            ))}
          </div>
        </div>

        <aside className="live-side">
          {(handoffs ?? []).map((h) => (
            <div key={h.jobId} className="wall-card">
              <div className="mono">{h.wall.toUpperCase()} WALL · JOB {h.jobId.slice(0, 8)} · GENERATION {h.generation}</div>
              <p>Clear it in the live frame, then resume. <a href={h.viewerUrl} target="_blank" rel="noreferrer">Open in Steel</a></p>
              <button type="button" className="secondary-action" onClick={() => resume(h)}>I cleared it, resume</button>
            </div>
          ))}
          <div className="panel-caption mono">STEEL USAGE TRACE</div>
          <ol className="trace-log">
            {trace.length === 0 && <li className="muted">Waiting for the first browser.</li>}
            {[...trace].reverse().slice(0, 40).map((t, i) => <li key={i} className={t.kind}><span className="mono">{t.at}</span>{t.text}</li>)}
          </ol>
          <div className="panel-caption mono">WHAT THE LOGIC IS DOING</div>
          {followedRuns.length === 0 && <p className="muted">Launch the demo to follow its logic here.</p>}
          {[...followedRuns].sort((a, b) => storyOrder(a) - storyOrder(b)).map((id) => <StoryCard key={id} runId={id} />)}
        </aside>
      </div>

      <Intelligence runIds={followedRuns} />
    </section>
  );
}

function StoryCard({ runId }: { runId: string }) {
  const story = usePoll<Story>(async () => {
    const [run, ev] = await Promise.all([apiGet<RunView>(`/runs/${runId}`), apiGet<{ events: StoredEvent[] }>(`/runs/${runId}/events?format=json`)]);
    return run?.ok ? storyFor(run, ev?.events ?? []) : null;
  }, 3000, [runId]);
  if (!story) return null;
  return (
    <div className="story">
      <div className="story-head"><span className="tag">{story.kind}</span> <strong>{story.competitor}</strong> {story.badges.map((b) => <span key={b} className="tag steel">{b}</span>)} <span className="muted mono">{story.status}</span></div>
      {story.lines.map((l, i) => <p key={i} className={`story-line ${l.tone}`} dangerouslySetInnerHTML={{ __html: l.html }} />)}
    </div>
  );
}

function Intelligence({ runIds }: { runIds: string[] }) {
  const [tab, setTab] = useState<"coverage" | "countries" | "prices" | "matrix">("coverage");
  const key = runIds.join(",");
  const data = usePoll(async () => {
    const out = { coverage: [] as CoveragePage[], grids: [] as BordersGrid[], prices: [] as PriceRow[], matrix: [] as MatrixRow[], note: "" };
    for (const id of runIds) {
      const [c, b, p, m] = await Promise.all([
        apiGet<{ pages: CoveragePage[] }>(`/runs/${id}/coverage`), apiGet<{ grids: BordersGrid[] }>(`/runs/${id}/borders`),
        apiGet<{ rows: PriceRow[] }>(`/runs/${id}/prices`), apiGet<{ rows: MatrixRow[]; note?: string }>(`/runs/${id}/matrix`),
      ]);
      out.coverage.push(...(c?.pages ?? [])); out.grids.push(...(b?.grids ?? [])); out.prices.push(...(p?.rows ?? [])); out.matrix.push(...(m?.rows ?? [])); out.note = out.note || m?.note || "";
    }
    return out;
  }, 10000, [key]);
  const tabs: Array<[typeof tab, string]> = [["coverage", "Coverage"], ["countries", "Countries"], ["prices", "Prices"], ["matrix", "Feature matrix"]];
  return (
    <div className="intel">
      <div className="panel-caption mono">WHAT PERISCOPE LEARNED · EVERY ROW LINKS BACK TO AN OBSERVATION AND A STEEL SESSION</div>
      <div className="view-controls" aria-label="Intelligence views">{tabs.map(([id, label]) => <button type="button" key={id} aria-pressed={tab === id} onClick={() => setTab(id)}>{label}</button>)}</div>
      <div className="table-region" role="region" tabIndex={0}>
        {!runIds.length && <p className="muted">Nothing yet. Launch the demo above.</p>}
        {tab === "coverage" && data && (data.coverage.length ? <table><thead><tr><th>Page</th><th>Fetch saw</th><th>Revealed</th><th>Missed by fetch</th><th>Documents</th><th>Vantages</th><th>Revealed by</th></tr></thead><tbody>{data.coverage.map((p, i) => <tr key={p.url + i}><td>{p.url.replace(/^https?:\/\//, "")}</td><td>{p.surface}</td><td>{p.hidden}</td><td className="accent">{p.counter}</td><td>{p.documents}</td><td>{p.vantages.length}</td><td>{Object.entries(p.byAction).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, v]) => `${k} (${v})`).join(", ")}</td></tr>)}</tbody></table> : <p className="muted">No pages yet.</p>)}
        {tab === "countries" && data && (data.grids.length ? data.grids.map((g) => (
          <div key={g.url} className="grid-block">
            <div className="mono muted">{g.url.replace(/^https?:\/\//, "")} · differs by country: <b>{g.differsByCountry ? "yes" : "no"}</b> · by device: <b>{g.differsByDevice ? "yes" : "no"}</b></div>
            <div className="country-cols">{g.countries.map((c) => (
              <div key={c.country}><div className="country-head"><strong>{countryName(c.country) ?? c.country}</strong> <span className="tag steel">via Steel proxy</span></div>
                {c.prices.slice(0, 6).map((l, i) => <div key={i} className="line price">{l.slice(0, 110)}</div>)}
                {c.uniqueToCountry.filter((l) => !c.prices.includes(l)).slice(0, 4).map((l, i) => <div key={i} className="line">{l.slice(0, 110)}</div>)}
              </div>))}</div>
          </div>)) : <p className="muted">No border run yet.</p>)}
        {tab === "prices" && data && (data.prices.length ? <table><thead><tr><th>Country</th><th>Device</th><th>Amount</th><th>Currency</th><th>Period</th><th>Text</th><th>Layer</th></tr></thead><tbody>{data.prices.slice(0, 80).map((r) => <tr key={r.observationId}><td>{countryName(r.country) ?? "home"}</td><td>{r.device}</td><td className="accent">{r.amount}</td><td>{r.currency ?? ""}</td><td>{r.period ?? ""}</td><td>{r.text.slice(0, 90)}</td><td>{r.layer}</td></tr>)}</tbody></table> : <p className="muted">No price lines yet.</p>)}
        {tab === "matrix" && data && (data.matrix.length ? <table><thead><tr><th>Competitor</th><th>Feature</th><th>Status</th><th>Value</th><th>Evidence</th></tr></thead><tbody>{data.matrix.map((r) => <tr key={r.id}><td>{r.competitor}</td><td>{r.feature}</td><td>{r.status}</td><td>{(r.value ?? "").slice(0, 100)}</td><td>{r.evidence.length}</td></tr>)}</tbody></table> : <p className="muted">{data.note || "The matrix fills a minute after a run completes, one Claude call per competitor."}</p>)}
      </div>
    </div>
  );
}

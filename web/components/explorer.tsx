"use client";

import { useState } from "react";
import snapshot from "@/public/snapshot.json";
import { Benchmark, SectionLabel } from "./sections";

export function EvidenceExplorer() {
  const [selected, setSelected] = useState("annual");
  const [view, setView] = useState("prices");
  const fact = snapshot.facts.find(f => f.id === selected)!;
  return <>
    <section className="section explorer" id="explore" aria-labelledby="explore-title"><SectionLabel index="03">INSIDE THE BROWSER</SectionLabel><div className="section-heading"><h2 id="explore-title">Follow the fact<br/>back to the click.</h2><p>Select an observation to inspect its page state and evidence path.</p></div>
      <div className="snapshot-heading mono"><span><i className="square"/> REPORTED OBSERVATIONS</span><span>STATIC SNAPSHOT · NO LIVE CONNECTION</span></div>
      <div className="session-grid" aria-label="Select a recovered observation">{snapshot.facts.map(f=><button type="button" key={f.id} aria-pressed={selected===f.id} className={`session ${selected===f.id?"active":""}`} onClick={()=>setSelected(f.id)}><div className="session-top mono"><span>{f.page.toUpperCase()}</span><span>{f.layer=== "Authenticated" ? "LOGIN WALL" : "PAGE CONTROL"}</span></div><h3>{f.title}</h3><div className="session-value">{f.value}<small>{f.unit}</small></div><dl><div><dt>Country / proxy</dt><dd>{f.country} / {f.proxy}</dd></div><div><dt>Device</dt><dd>{f.device}</dd></div><div><dt>Signed in</dt><dd>{f.signedIn}</dd></div><div><dt>Wall</dt><dd>{f.wall}</dd></div></dl><span className="session-action">{f.action}<span aria-hidden="true">↗</span></span></button>)}</div>
      <div className="evidence-detail" aria-live="polite" aria-atomic="true"><div className="route-title mono">SELECTED PATH <span>{fact.title.toUpperCase()}</span></div><ol className="route">{fact.route.map((r,i)=><li key={r}><span className="route-node" aria-hidden="true">{i===3?"✓":""}</span>{r}</li>)}</ol>
      {fact.id === "seats" && <p className="handoff-note">At a wall, Periscope supports human takeover and session resume. The reported seat observation confirms signed-in access; its handoff events were not supplied.</p>}
      <div className="trace-heading mono"><span>OBSERVATION TRACE</span><span>TIMESTAMP / EVENT</span></div><ol className="trace">{fact.trace.map((t,i)=><li key={t}><span className="trace-time">{fact.timestamp ?? "—"}</span><span className="trace-type">{["PAGE", "ACTION", "OBSERVE", "CONTEXT"][i]}</span><span>{t}</span></li>)}</ol><p className="data-note">Path reconstructed from the reported example. Original event timestamps, browser IDs, proxies, and device metadata were not supplied; dashes indicate unavailable timestamps.</p></div>
    </section>
    <Benchmark/>
    <section className="section recovered" id="data" aria-labelledby="data-title"><SectionLabel index="05">THE INTELLIGENCE OUTPUT</SectionLabel><div className="section-heading"><h2 id="data-title">The page changes.<br/>The context stays.</h2><p>Inspect the recovered values, the conditions attached to them, and the limits of this snapshot.</p></div>
      <div className="view-controls" aria-label="Recovered data views">{[{id:"prices",label:"Prices by country"},{id:"coverage",label:"Page coverage"},{id:"matrix",label:"Feature matrix"}].map(v=><button type="button" key={v.id} aria-pressed={view===v.id} onClick={()=>setView(v.id)}>{v.label}<span aria-hidden="true">↗</span></button>)}</div>
      <div className="table-region" role="region" aria-label={`${view} data table`} tabIndex={0}>
      {view==="prices" && <table><caption>Reported pricing observations. Currency is preserved; country cannot be inferred from currency alone.</caption><thead><tr><th>Country</th><th>Price observed</th><th>Condition</th><th>Evidence</th></tr></thead><tbody>{snapshot.facts.filter(f=>f.id!=="seats").map(f=><tr key={f.id}><td>{f.country}<small>{f.currency}</small></td><td className="price-cell">{f.value}<small>{f.unit}</small></td><td>{f.context}</td><td><a href="#explore" onClick={()=>setSelected(f.id)}>Inspect path ↗</a></td></tr>)}</tbody></table>}
      {view==="coverage" && <table><caption>Example-level evidence only. Per-page totals were not supplied, so page coverage percentages are not calculated.</caption><thead><tr><th>Page</th><th>Reported examples</th><th>Recovery layer</th><th>Full page coverage</th></tr></thead><tbody><tr><td>Pricing</td><td>Annual price; volume price</td><td>Interaction</td><td>Not measured in snapshot</td></tr><tr><td>Dashboard</td><td>Team seats used</td><td>Authenticated</td><td>Not measured in snapshot</td></tr><tr><td>Whole target</td><td>63 of 65 planted facts</td><td>Combined</td><td>See benchmark method</td></tr></tbody></table>}
      {view==="matrix" && <table><caption>Recovery requirements for the supplied examples. This is not a feature comparison between AI vendors.</caption><thead><tr><th>Recovered fact</th><th>Required page state</th><th>Evidence layer</th><th>Reported result</th></tr></thead><tbody>{snapshot.facts.map(f=><tr key={f.id}><td>{f.title}</td><td>{f.control}</td><td>{f.layer}</td><td>{f.quote}</td></tr>)}</tbody></table>}
      </div><div className="data-footer"><span className="mono">SOURCE: PROJECT TEAM’S REPORTED EXAMPLES</span><a className="text-link" href="/snapshot.json" download>Download snapshot <span aria-hidden="true">↓</span></a></div>
    </section>
  </>;
}

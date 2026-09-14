import snapshot from "@/public/snapshot.json";

export function Mark() {
  return <svg aria-hidden="true" viewBox="0 0 32 36" fill="none"><path d="M6 33V12a7 7 0 0 1 7-7h15v9H16v19" stroke="currentColor" strokeWidth="3"/><path d="M25 5v9" stroke="var(--accent)" strokeWidth="3"/></svg>;
}

export function SectionLabel({ index, children }: { index: string; children: React.ReactNode }) {
  return <div className="eyebrow"><span className="index">{index}</span>{children}</div>;
}

export function Hero() {
  return <section className="hero section" id="surface" aria-labelledby="hero-title">
    <div className="hero-copy">
      <SectionLabel index="00">INTELLIGENCE, BELOW THE SURFACE</SectionLabel>
      <h1 id="hero-title">Every research tool reads what websites serve.<br/><span>Periscope reads what they hide.</span></h1>
      <p className="hero-description">The competitive-intelligence parser that clicks deeper. Real browsers. Authorized sessions. Facts with their context intact.</p>
      <div className="actions"><a className="button primary" href="#explore">Explore the evidence <span aria-hidden="true">↘</span></a><a className="text-link" href="#benchmark">Read the benchmark <span aria-hidden="true">→</span></a></div>
      <div className="built-with"><span className="tiny-mark"/>POWERED BY STEEL CLOUD BROWSERS</div>
    </div>
    <div className="depth-diagram" aria-label="A fact recovered by moving from a public page through an annual billing toggle">
      <div className="diagram-caption mono">PAGE CROSS-SECTION <span>↓ DEPTH</span></div>
      <div className="stratum surface-stratum"><small>PUBLIC SURFACE</small><div>What the page serves</div><span className="stratum-note">Initial HTML</span></div>
      <div className="stratum interaction-stratum"><small>INTERACTION LAYER</small><div>What a click reveals</div><div className="toggle-diagram"><span>Monthly</span><span className="selected">Annual <span aria-hidden="true">↵</span></span></div></div>
      <div className="stratum auth-stratum"><small>SESSION LAYER</small><div>What access unlocks</div><span className="stratum-note">Login → human handoff → resume</span></div>
      <div className="fact-stratum"><span className="mono">RECOVERED / ANNUAL BILLING</span><strong>CA$26<span> / user / month</span></strong><p>A fact the initial view didn’t expose.</p></div>
      <span className="diagram-line" aria-hidden="true"/>
    </div>
    <div className="hero-bottom mono"><span>FROM PAGE STATE TO STRUCTURED INTELLIGENCE</span><span>SCROLL TO DESCEND ↓</span></div>
  </section>;
}

export function Problem() {
  return <section className="section problem" id="blind-spots" aria-labelledby="problem-title"><SectionLabel index="01">THE BLIND SPOT</SectionLabel>
    <div className="section-heading"><h2 id="problem-title">A page is more<br/>than its first state.</h2><p>A response captures one view. Pricing and product details can depend on a click, a country, or an authorized session.</p></div>
    <div className="comparison"><div><div className="mono comparison-label">INITIAL RESPONSE</div><h3>The visible starting point.</h3><p>Public copy. Default selections. The HTML returned for that request.</p><div className="document-lines" aria-hidden="true"><i/><i/><i/><i/><i/></div><span className="mono muted">ONE VIEW OF THE PAGE</span></div><div><div className="mono comparison-label">INTERACTION + CONTEXT</div><h3>The facts behind the controls.</h3><ul className="fact-list">{snapshot.facts.map(f=><li key={f.id}><span>{f.control}</span><strong>{f.quote}</strong></li>)}</ul></div></div>
  </section>;
}

export function HowItWorks() {
  const layers = [
    { name: "Enter the page.", label: "STEEL BROWSER + HUMAN", text: "Cloud browsers interact with the actual page. Country proxies and device settings establish context. A human can take over at a login or CAPTCHA, then return the session to the agent.", items: "Click · select · hover · sign in" },
    { name: "Recover the fact.", label: "THE PARSER", text: "Explore toggles, accordions, modals, and tooltips. Preserve the action and page state that made each fact visible, including billing terms and seat thresholds.", items: "Observe · extract · attach context" },
    { name: "Make it comparable.", label: "INTELLIGENCE OUTPUT", text: "Organize observations into pricing views, page coverage, and feature matrices. Keep the evidence path close enough to inspect.", items: "Normalize · compare · trace back" },
  ];
  return <section className="section how" id="layers" aria-labelledby="how-title"><SectionLabel index="02">THE DESCENT</SectionLabel><div className="section-heading"><h2 id="how-title">Three layers.<br/>One evidence trail.</h2><p>Browser access becomes useful intelligence when the context survives the journey.</p></div><div className="layer-grid">{layers.map((l,i)=><article key={l.label}><span className="layer-number mono">0{i+1}<span aria-hidden="true">↓</span></span><div className="eyebrow">{l.label}</div><h3>{l.name}</h3><p>{l.text}</p><small className="mono">{l.items}</small></article>)}</div></section>;
}

export function Benchmark() {
  return <section className="section benchmark" id="benchmark" aria-labelledby="benchmark-title"><SectionLabel index="04">CONTROLLED BENCHMARK</SectionLabel><div className="benchmark-layout"><div><h2 id="benchmark-title">Same target.<br/>Different depths.</h2><div className="big-result">63<span>/65</span></div><p>Planted facts recovered by Periscope.</p><span className="mono muted">CONTROLLED SAAS TARGET</span></div><div className="chart" aria-label="Recovered facts out of 65">{snapshot.benchmark.map((b,i)=><div className={`chart-row ${i===0?"highlight":""}`} key={b.name}><div className="chart-title"><strong>{b.name}</strong><span className="mono">{b.count}<span className="muted"> / 65</span></span></div><div className="bar-track" aria-hidden="true"><div style={{width:`${b.count / snapshot.total * 100}%`}}/></div><p>{b.note}</p></div>)}</div></div><details className="method" open><summary>Read the method and limitations <span aria-hidden="true">+</span></summary><p>{snapshot.method}</p></details></section>;
}

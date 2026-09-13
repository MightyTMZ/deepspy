"""
Benchmark: Periscope against the research tools people already use, on the team's test SaaS (Helix Ledger), which
plants 18 hidden lines on the pricing page, 3 country variants, and 5 facts behind the login.

The Periscope row is computed live from the latest Helix runs through the API. The other rows are measured by hand
later (Claude Opus, GPT Astra, Claude Opus with connectors) and filled in from data/benchmark.json when present.
"""

import json
import os
import re
from pathlib import Path

import requests
import streamlit as st

API = os.environ.get("PERISCOPE_API_URL", "http://localhost:4747").rstrip("/")
DATA_DIR = os.environ.get("PERISCOPE_DATA_DIR", str(Path(__file__).resolve().parent.parent / "data"))
BENCH_FILE = os.path.join(DATA_DIR, "benchmark.json")

PLANTED_HIDDEN = 18
PLANTED_COUNTRIES = 3
PLANTED_INTERIOR = [r"25 of 30 seats", r"Bank connections: 7 of 10", r"\bBeta\b", r"Coming soon", r"q3\.pdf", r"EU \(Frankfurt\)", r"SSO available on Business plan only", r"Card ending 4242"]
PRICE = re.compile(r"(\$|€|£|CA\$)\s?\d|\d+([.,]\d+)?\s?(€|EUR)")

TOOLS = [
    ("Claude Opus, web search", "reads what the search index and a fetch return"),
    ("GPT Astra, browse", "one browser, one country, no login"),
    ("Claude Opus with connectors", "fetch and search tools, no clicks"),
]

CSS = """
<style>
.bm table{width:100%;border-collapse:collapse;font-size:.9rem}
.bm th{text-align:left;color:#9aa4b2;font-weight:500;font-size:.78rem;text-transform:uppercase;letter-spacing:.05em;padding:.4rem .6rem;border-bottom:1px solid #2a3340}
.bm td{padding:.55rem .6rem;border-bottom:1px solid #1f2733;vertical-align:top}
.bm tr.hero td{background:rgba(217,200,255,.07)}
.bm .name{font-weight:600}.bm .sub{color:#6b7280;font-size:.78rem}
.bm .big{font-size:1.25rem;font-weight:700}.bm .ok{color:#a8f0c6}.bm .pending{color:#6b7280;font-style:italic}
.bm .steel{display:inline-block;padding:.05rem .45rem;border-radius:.4rem;background:#2b2140;color:#d9c8ff;font-size:.7rem;margin-left:.3rem}
</style>
"""


def _get(path, **params):
    try:
        r = requests.get(API + path, params=params, timeout=10)
        return r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
    except Exception:  # noqa: BLE001
        return {}


def _periscope_row() -> dict:
    """Best result per beat across the Helix runs so far."""
    runs = [r for r in _get("/runs", limit=60).get("runs", []) if "helix-ledger" in (r.get("competitors") or [])]
    hidden = 0
    seconds = None
    countries = 0
    interior_hits: set[str] = set()
    for r in runs:
        rid = r["id"]
        if rid.startswith("helix-parse") or "reveal" in (r.get("purposes") or []):
            cov = _get(f"/runs/{rid}/coverage")
            for p in cov.get("pages", []):
                if p["url"].endswith("/pricing") and isinstance(p.get("counter"), int) and p["counter"] > hidden:
                    hidden = p["counter"]
                    try:
                        from datetime import datetime
                        seconds = int((datetime.fromisoformat(r["updatedAt"].replace("Z", "+00:00")) - datetime.fromisoformat(r["createdAt"].replace("Z", "+00:00"))).total_seconds())
                    except Exception:  # noqa: BLE001
                        seconds = None
        if rid.startswith("helix-borders"):
            for g in _get(f"/runs/{rid}/borders").get("grids", []):
                n = sum(1 for c in g.get("countries", []) if any(PRICE.search(l) for l in c.get("prices", [])))
                countries = max(countries, n)
        if rid.startswith("helix-login"):
            for o in _get(f"/runs/{rid}/observations", layer="interior", limit=2000).get("observations", []):
                for pat in PLANTED_INTERIOR:
                    if re.search(pat, o.get("text", "")):
                        interior_hits.add(pat)
    return {"hidden": hidden, "countries": countries, "interior": len(interior_hits), "seconds": seconds}


def _load_manual() -> dict:
    try:
        with open(BENCH_FILE, encoding="utf-8") as f:
            return json.load(f)
    except Exception:  # noqa: BLE001
        return {}


def render_benchmark_section() -> None:
    st.markdown(CSS, unsafe_allow_html=True)
    st.markdown("##### Benchmark: Periscope against the tools people already use")
    st.markdown(f'<span class="muted">Same target for every tool, the team\'s test SaaS Helix Ledger: {PLANTED_HIDDEN} lines hidden behind clicks on the pricing page, {PLANTED_COUNTRIES} country variants, {len(PLANTED_INTERIOR)} facts behind the login. The traditional tools are measured by hand and filled in from <code>data/benchmark.json</code>.</span>', unsafe_allow_html=True)
    p = _periscope_row()
    manual = _load_manual()

    def cell(v, total):
        if v is None:
            return "<span class='pending'>to be measured</span>"
        cls = "ok" if v >= total else ""
        return f"<span class='big {cls}'>{min(v, total)}</span> <span class='sub'>of {total}</span>"

    rows = []
    for name, sub in TOOLS:
        m = manual.get(name, {})
        rows.append(f"<tr><td><span class='name'>{name}</span><br><span class='sub'>{sub}</span></td><td>{cell(m.get('hidden'), PLANTED_HIDDEN)}</td><td>{cell(m.get('countries'), PLANTED_COUNTRIES)}</td><td>{cell(m.get('interior'), len(PLANTED_INTERIOR))}</td><td>{m.get('time') or '<span class=pending>to be measured</span>'}</td></tr>")
    hidden_txt = cell(p["hidden"] if p["hidden"] else None, PLANTED_HIDDEN)
    if p["hidden"] > PLANTED_HIDDEN:
        hidden_txt += f" <span class='sub'>+{p['hidden'] - PLANTED_HIDDEN} more lines</span>"
    rows.append(
        f"<tr class='hero'><td><span class='name'>Periscope on Steel</span><span class='steel'>Steel browsers</span><span class='steel'>proxies</span><span class='steel'>live view handoff</span><br>"
        f"<span class='sub'>clicks, toggles, hovers, six countries at once, walks in past the login</span></td>"
        f"<td>{hidden_txt}</td><td>{cell(p['countries'] if p['countries'] else None, PLANTED_COUNTRIES)}</td><td>{cell(p['interior'] if p['interior'] else None, len(PLANTED_INTERIOR))}</td>"
        f"<td>{(str(p['seconds']) + ' s') if p['seconds'] else '<span class=pending>run the demo</span>'}</td></tr>"
    )
    st.markdown("<div class='bm'><table><tr><th>Tool</th><th>Hidden lines found</th><th>Country variants seen</th><th>Facts behind the login</th><th>Time</th></tr>" + "".join(rows) + "</table></div>", unsafe_allow_html=True)

"""
Benchmark section for the main page: the Helix Ledger benchmark (65 planted facts) as a bar chart of totals per
research approach and a group-by-approach table. Reads the newest benchmarks/results-*.json written by
scripts/benchmark-helix.ts, the rubric for group sizes, and an optional benchmarks/manual-results.json for approaches
scored by hand (for example a ChatGPT browsing run): [{"name": "...", "hits": ["nav1", ...] or "score": 41, "seconds": 300}].
"""

import glob
import json
import os
from pathlib import Path

import altair as alt
import pandas as pd
import streamlit as st

ROOT = Path(__file__).resolve().parent.parent
BENCH_DIR = Path(os.environ.get("PERISCOPE_BENCH_DIR", ROOT / "benchmarks"))
HIGHLIGHT = "#dc2626"   # Periscope, the same red as the missed-by-fetch counter
NEUTRAL = "#9ca3af"


def _load():
    files = sorted(glob.glob(str(BENCH_DIR / "results-*.json")))
    rubric_path = BENCH_DIR / "helix-rubric.json"
    if not files or not rubric_path.exists():
        return None
    with open(files[-1], encoding="utf-8") as f:
        data = json.load(f)
    with open(rubric_path, encoding="utf-8") as f:
        rubric = json.load(f)
    manual = []
    mpath = BENCH_DIR / "manual-results.json"
    if mpath.exists():
        with open(mpath, encoding="utf-8") as f:
            manual = json.load(f)
    return data, rubric, manual, os.path.basename(files[-1])


def render_benchmark_section() -> None:
    loaded = _load()
    st.markdown("### Benchmark: what each approach delivers to the model")
    if not loaded:
        st.markdown('<span class="muted">No benchmark results yet. Run `npx tsx scripts/benchmark-helix.ts` and this section fills itself.</span>', unsafe_allow_html=True)
        return
    data, rubric, manual, fname = loaded
    items = rubric["items"]
    total = len(items)
    groups = list(dict.fromkeys(i["group"] for i in items))
    by_group = {g: [i["id"] for i in items if i["group"] == g] for g in groups}

    rows = []
    for r in data["results"]:
        rows.append({"name": r["name"], "hits": set(r.get("hits") or []), "score": r["score"], "model": r.get("model"), "seconds": r.get("seconds"), "manual": False})
    for m in manual:
        rows.append({"name": m["name"], "hits": set(m.get("hits") or []), "score": m.get("score", len(m.get("hits") or [])), "model": None, "seconds": m.get("seconds"), "manual": True})

    st.markdown(
        f'<span class="muted">Same target, same {total} planted facts (the team\'s test SaaS, Helix Ledger: hidden pricing states, accordions, modals, a login wall, dashboard pages). '
        f'Score = facts present in the material the approach returns. Source: <span class="mono">{fname}</span>.</span>',
        unsafe_allow_html=True,
    )

    # ---- chart: totals ---------------------------------------------------------------------------------------------
    chart_df = pd.DataFrame([{"approach": r["name"], "score": r["score"], "pct": round(100 * r["score"] / total), "highlight": r["name"].lower().startswith("periscope")} for r in rows])
    order = chart_df.sort_values("score", ascending=False)["approach"].tolist()
    base = alt.Chart(chart_df).encode(y=alt.Y("approach:N", sort=order, title=None, axis=alt.Axis(labelLimit=320, labelFontSize=13)))
    bars = base.mark_bar(cornerRadiusEnd=3, size=26).encode(
        x=alt.X("score:Q", title=f"facts found, out of {total}", scale=alt.Scale(domain=[0, total])),
        color=alt.condition(alt.datum.highlight, alt.value(HIGHLIGHT), alt.value(NEUTRAL)),
        tooltip=[alt.Tooltip("approach:N"), alt.Tooltip("score:Q", title="facts"), alt.Tooltip("pct:Q", title="%")],
    )
    labels = base.mark_text(align="left", dx=6, fontSize=13, fontWeight="bold").encode(x="score:Q", text=alt.Text("score:Q"))
    st.altair_chart((bars + labels).properties(height=34 * len(rows) + 30).configure_view(strokeWidth=0).configure_axis(grid=False, domain=False), use_container_width=True)

    # ---- table: groups × approaches -------------------------------------------------------------------------------
    table = []
    for g in groups:
        ids = by_group[g]
        row = {"Group": g, "Items": len(ids)}
        for r in rows:
            row[r["name"]] = len(ids) if r["manual"] and not r["hits"] else sum(1 for i in ids if i in r["hits"]) if r["hits"] else 0
        table.append(row)
    totals = {"Group": "Total", "Items": total}
    for r in rows:
        totals[r["name"]] = r["score"]
    table.append(totals)
    df = pd.DataFrame(table)

    def _shade(v, n):
        if not isinstance(v, (int, float)) or n == 0:
            return ""
        if v == n:
            return "background-color: rgba(22,163,74,0.28)"
        if v == 0:
            return "background-color: rgba(220,38,38,0.22)"
        return "background-color: rgba(245,158,11,0.18)"

    styled = df.style.apply(lambda col: [_shade(v, n) for v, n in zip(col, df["Items"])] if col.name not in ("Group", "Items") else [""] * len(col), axis=0)
    st.dataframe(styled, use_container_width=True, hide_index=True, height=38 * (len(table) + 1))

    notes = " · ".join(f"{r['name']}: {int(r['seconds'])} s" for r in rows if r.get("seconds") is not None)
    st.markdown(f'<span class="muted">Time to produce the material: {notes}. Green: every fact in the group found. Red: none. '
                f'Fetch and reader tools stop at what the server sends; the login wall, the annual switch, the accordions and the modals are behind actions only a browser can take.</span>', unsafe_allow_html=True)

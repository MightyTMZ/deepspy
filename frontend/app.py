"""
Periscope, Streamlit frontend over the Periscope API (docs/api.md).

Start the API first:   npm run api            (port 4747, needs STEEL_API_KEY to launch runs)
Then this app:         streamlit run frontend/app.py
Point at another API:  PERISCOPE_API_URL=http://host:4747 streamlit run frontend/app.py

The app never touches SQLite or Steel itself. Every number on screen comes from an API response,
so the same screens work against fixtures/api/*.json for design work.
"""

import json
import os
import time
import uuid
from pathlib import Path

import requests
import streamlit as st

API = os.environ.get("PERISCOPE_API_URL", "http://localhost:4747").rstrip("/")
DATA_DIR = os.environ.get("PERISCOPE_DATA_DIR", str(Path(__file__).resolve().parent.parent / "data"))
COMPETITORS_FILE = os.path.join(DATA_DIR, "competitors.json")
DEVICE_PASSWORD = os.environ.get("PERISCOPE_PASSWORD", "")
TERMINAL = {"completed", "failed", "cancelled", "partial"}

st.set_page_config(page_title="Periscope", layout="wide")
st.markdown(
    """
<style>
  .block-container { padding-top: 1.5rem; }
  .mono { font-family: 'SF Mono', 'Fira Code', monospace; font-size: 0.85rem; }
  .muted { color: #6b7280; font-size: 0.85rem; }
  .counter { font-size: 3rem; font-weight: 800; color: #dc2626; line-height: 1; }
  .counter-label { color: #6b7280; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.06em; }
  /* explicit colours so the boxes read in both Streamlit themes */
  .hidden-line { border-left: 3px solid #dc2626; padding: 0.35rem 0.75rem; margin: 0.25rem 0; background: rgba(220,38,38,0.08); font-size: 0.85rem; }
  .surface-line { border-left: 3px solid #9ca3af; padding: 0.35rem 0.75rem; margin: 0.25rem 0; background: rgba(156,163,175,0.12); font-size: 0.85rem; opacity: 0.9; }
  .wall { border: 1px solid #f59e0b; background: rgba(245,158,11,0.12); padding: 0.75rem 1rem; border-radius: 6px; }
  .competitor-item { padding: 0.5rem 0; border-bottom: 1px solid #e5e7eb; font-family: 'SF Mono', 'Fira Code', monospace; font-size: 0.85rem; }
</style>
""",
    unsafe_allow_html=True,
)


# ---------------------------------------------------------------------------
# API client
# ---------------------------------------------------------------------------

def api_get(path: str, **params):
    try:
        r = requests.get(f"{API}{path}", params=params or None, timeout=15)
        return r.status_code, r.json()
    except requests.RequestException as e:
        return 0, {"ok": False, "reason": str(e)}


def api_post(path: str, body: dict | None = None, headers: dict | None = None):
    try:
        r = requests.post(f"{API}{path}", json=body or {}, headers=headers or {}, timeout=30)
        return r.status_code, r.json()
    except requests.RequestException as e:
        return 0, {"ok": False, "reason": str(e)}


def api_health():
    code, body = api_get("/health")
    return body if code == 200 else None


# ---------------------------------------------------------------------------
# Competitor list (JSON file next to the database)
# ---------------------------------------------------------------------------

def load_competitors() -> list[dict]:
    if os.path.exists(COMPETITORS_FILE):
        with open(COMPETITORS_FILE) as f:
            return json.load(f)
    # Demo set: Steel's five closest competitors in browser infrastructure, pricing pages first.
    return [
        {"name": "browserbase", "url": "https://www.browserbase.com", "pages": ["/pricing"]},
        {"name": "hyperbrowser", "url": "https://www.hyperbrowser.ai", "pages": ["/pricing"]},
        {"name": "anchor", "url": "https://anchorbrowser.io", "pages": ["/pricing"]},
        {"name": "browserless", "url": "https://www.browserless.io", "pages": ["/pricing"]},
        {"name": "kernel", "url": "https://www.onkernel.com", "pages": ["/pricing"]},
    ]


def save_competitors(competitors: list[dict]) -> None:
    os.makedirs(os.path.dirname(COMPETITORS_FILE), exist_ok=True)
    with open(COMPETITORS_FILE, "w") as f:
        json.dump(competitors, f, indent=2)


# ---------------------------------------------------------------------------
# State
# ---------------------------------------------------------------------------

for key, default in {"editing": False, "active_runs": [], "chat_messages": [], "live": True}.items():
    if key not in st.session_state:
        st.session_state[key] = default

health = api_health()

# ---------------------------------------------------------------------------
# Header
# ---------------------------------------------------------------------------

st.markdown('<h1 style="color:#16a34a;font-weight:800;font-size:2.4rem;margin-bottom:0.1rem;">Periscope</h1>', unsafe_allow_html=True)
st.markdown('<p class="muted" style="margin-top:0">Every research tool reads what a website serves. Periscope reads what a website hides. Demo set: the browser-infrastructure market, seen from Steel.</p>', unsafe_allow_html=True)
if not health:
    st.error(f"API not reachable at {API}. Start it with `npm run api` (set PERISCOPE_API_URL to point elsewhere).")
    st.stop()
if not health.get("steel"):
    st.warning("API is running without STEEL_API_KEY: results from earlier runs are browsable, new runs cannot be launched.")

st.divider()
left_col, right_col = st.columns([3, 2], gap="large")

# ---------------------------------------------------------------------------
# Right: competitors
# ---------------------------------------------------------------------------

with right_col:
    st.markdown("##### Competitors")
    competitors = load_competitors()
    c_edit, _ = st.columns([1, 3])
    with c_edit:
        if not st.session_state.editing:
            if st.button("Edit", use_container_width=True):
                st.session_state.editing = "pending_auth" if DEVICE_PASSWORD else True
                st.rerun()
        else:
            if st.button("Lock", use_container_width=True):
                st.session_state.editing = False
                st.rerun()

    if st.session_state.editing == "pending_auth":
        pw = st.text_input("Password", type="password", key="pw_input")
        if st.button("Unlock"):
            if pw == DEVICE_PASSWORD:
                st.session_state.editing = True
                st.rerun()
            else:
                st.error("Incorrect password.")

    if st.session_state.editing is True:
        st.caption("Add, edit, or remove competitors. Click Lock when done.")
        updated = []
        for i, comp in enumerate(competitors):
            c1, c2, c3 = st.columns([2, 3, 1])
            with c1:
                name = st.text_input("Name", value=comp["name"], key=f"name_{i}", label_visibility="collapsed")
            with c2:
                url = st.text_input("URL", value=comp["url"], key=f"url_{i}", label_visibility="collapsed")
            with c3:
                remove = st.button("Remove", key=f"rm_{i}")
            if not remove:
                pages_str = st.text_input("Pages", value=",".join(comp.get("pages", ["/"])), key=f"pages_{i}", label_visibility="collapsed")
                updated.append({"name": name, "url": url, "pages": [p.strip() for p in pages_str.split(",") if p.strip()]})
        if st.button("+ Add competitor"):
            competitors.append({"name": "", "url": "https://", "pages": ["/"]})
            save_competitors(competitors)
            st.rerun()
        if updated != competitors:
            save_competitors(updated)
    else:
        for comp in competitors:
            st.markdown(
                f'<div class="competitor-item"><strong>{comp["name"]}</strong> <span class="muted">{comp["url"]}</span>'
                f'<br><span class="muted">pages: {", ".join(comp.get("pages", ["/"]))}</span></div>',
                unsafe_allow_html=True,
            )

    # Human in the loop: pending walls from every run
    st.markdown("##### Walls waiting for a human")
    _, hand = api_get("/handoffs")
    handoffs = hand.get("handoffs", []) if isinstance(hand, dict) else []
    if not handoffs:
        st.caption("None. A CAPTCHA, login, 2FA or payment page will appear here with a live view link.")
    for h in handoffs:
        st.markdown(
            f'<div class="wall"><strong>{h["wall"]}</strong> on job <span class="mono">{h["jobId"][:8]}</span> '
            f'(generation {h["generation"]})<br><a href="{h["viewerUrl"]}" target="_blank">Open the live view and clear it</a></div>',
            unsafe_allow_html=True,
        )
        if st.button("I cleared it, resume", key=f"resume_{h['jobId']}"):
            code, body = api_post(f"/jobs/{h['jobId']}/resume", {"generation": h["generation"]})
            if code == 200:
                st.success("Resumed in the same session.")
            else:
                st.error(body.get("reason", "resume failed"))
            st.rerun()

# ---------------------------------------------------------------------------
# Left: run controls
# ---------------------------------------------------------------------------

with left_col:
    run_disabled = not competitors or all(not c.get("url") for c in competitors) or not health.get("steel")
    c_run, c_jobs, c_countries, c_cap = st.columns([1, 2, 2, 1])
    with c_run:
        run_clicked = st.button("Run", type="primary", disabled=run_disabled, use_container_width=True)
    with c_jobs:
        jobs = st.multiselect("Jobs", ["surface", "benchmark", "reveal", "borders"], default=["surface", "benchmark", "reveal", "borders"], label_visibility="collapsed")
    with c_countries:
        countries_input = st.text_input("Countries", value="CA,US,DE", label_visibility="collapsed", placeholder="CA,US,DE")
    with c_cap:
        cap_usd = st.number_input("Cap $", min_value=1, max_value=100, value=12, label_visibility="collapsed")

    if run_clicked:
        batch = uuid.uuid4().hex[:6]
        started = []
        for comp in competitors:
            if not comp.get("url") or not comp.get("name"):
                continue
            run_id = f"{comp['name']}-{time.strftime('%m%d-%H%M%S')}-{batch}"
            code, body = api_post(
                "/runs",
                {"runId": run_id, "competitor": comp["name"], "url": comp["url"], "pages": comp.get("pages", ["/"]), "jobs": jobs,
                 "countries": [c.strip() for c in countries_input.split(",") if c.strip()], "capUsd": cap_usd, "category": "demo"},
                headers={"Idempotency-Key": f"{batch}-{comp['name']}"},
            )
            if code in (200, 202):
                started.append(body["runId"])
            else:
                st.error(f"{comp['name']}: {body.get('reason', code)}")
        if started:
            st.session_state.active_runs = started
            st.session_state.chat_messages = []
            st.success(f"Started {len(started)} run(s).")
            st.rerun()

    # ---------------- run picker ----------------
    _, runs_body = api_get("/runs", limit=50)
    all_runs = runs_body.get("runs", []) if isinstance(runs_body, dict) else []
    if not st.session_state.active_runs and all_runs:
        st.markdown("##### Runs")
        for r in all_runs[:15]:
            c_info, c_btn = st.columns([5, 1])
            with c_info:
                st.markdown(
                    f'<span class="mono">{r["id"]}</span> <span class="muted">{", ".join(r.get("competitors", []))}</span> '
                    f'&nbsp; <strong>{r["status"]}</strong> &nbsp; {r["observations"]} observations &nbsp; ${r["spentUsd"]:.2f}',
                    unsafe_allow_html=True,
                )
            with c_btn:
                if st.button("Open", key=f"open_{r['id']}"):
                    st.session_state.active_runs = [r["id"]]
                    st.session_state.chat_messages = []
                    st.rerun()

    # ---------------- active run(s) ----------------
    any_live = False
    for run_id in st.session_state.active_runs:
        code, view = api_get(f"/runs/{run_id}")
        if code != 200:
            st.warning(f"{run_id}: {view.get('reason', code)}")
            continue
        run = view["run"]
        status = run["status"]
        if status not in TERMINAL or run.get("live"):
            any_live = True

        st.markdown(f"##### Run <span class='mono'>{run_id}</span>", unsafe_allow_html=True)
        m1, m2, m3, m4 = st.columns(4)
        m1.metric("Status", status.upper()[:9])
        m2.metric("Observations", view["counts"]["observations"])
        m3.metric("Spend", f"${run['spentUsd']:.2f} of ${run['capUsd']:.0f}")
        # one counter per page: the latest value wins (borders emits one per vantage for the same url)
        latest = {}
        for c in view["counters"]:
            latest[c["url"]] = c["missed"]
        if any(v == "uncertain" for v in latest.values()):
            m4.metric("Missed by fetch", "uncertain")
        else:
            m4.metric("Missed by fetch", sum(v for v in latest.values() if isinstance(v, int)) if latest else "-")

        for job in view["jobs"]:
            mark = {"queued": "[ ]", "starting": "[.]", "running": "[~]", "awaiting_human": "[!]", "finalizing": "[~]", "completed": "[x]", "partial": "[/]", "failed": "[-]", "cancelled": "[-]"}.get(job["state"], "[ ]")
            reason = f' <span class="muted">{job["reason"]}</span>' if job.get("reason") else ""
            st.markdown(f'<div class="mono">{mark} {job["purpose"]} {job.get("competitor") or ""} <span class="muted">{job.get("url") or ""}</span>{reason}</div>', unsafe_allow_html=True)

        if status not in TERMINAL:
            if st.button("Cancel queued jobs", key=f"cancel_{run_id}"):
                api_post(f"/runs/{run_id}/cancel")
                st.rerun()

        tab_side, tab_borders, tab_prices, tab_diff, tab_matrix, tab_events = st.tabs(["Side by side", "Borders", "Prices", "Diff", "Matrix", "Events"])

        with tab_side:
            _, cov = api_get(f"/runs/{run_id}/coverage")
            for page in cov.get("pages", []):
                counter = page.get("counter")
                a, b = st.columns([1, 3])
                with a:
                    st.markdown(f'<div class="counter">{counter}</div><div class="counter-label">missed by fetch</div>', unsafe_allow_html=True)
                with b:
                    st.markdown(f'<span class="mono">{page["url"]}</span>', unsafe_allow_html=True)
                    st.markdown(f'<span class="muted">fetch tool saw {page["surface"]} lines. Periscope revealed {page["hidden"]} more, {page["documents"]} of them documents, from {", ".join(page["vantages"])}</span>', unsafe_allow_html=True)
                    actions = ", ".join(f"{k} ({v})" for k, v in sorted(page["byAction"].items(), key=lambda kv: -kv[1])[:5])
                    if actions:
                        st.markdown(f'<span class="muted">revealed by: {actions}</span>', unsafe_allow_html=True)
                _, hidden = api_get(f"/runs/{run_id}/observations", layer="hidden", missedByFetch=1, limit=40)
                left, right = st.columns(2)
                with left:
                    st.caption("What a fetch tool returns")
                    _, surf = api_get(f"/runs/{run_id}/observations", layer="surface", limit=12)
                    for o in [x for x in surf.get("observations", []) if x["url"] == page["url"]][:12]:
                        st.markdown(f'<div class="surface-line">{o["text"][:140]}</div>', unsafe_allow_html=True)
                with right:
                    st.caption("What Periscope found behind clicks")
                    for o in [x for x in hidden.get("observations", []) if x["url"] == page["url"]][:12]:
                        via = (o.get("revealedBy") or {}).get("label") or (o.get("revealedBy") or {}).get("action") or ""
                        st.markdown(f'<div class="hidden-line">{o["text"][:140]}<br><span class="muted">via {via} · {o["kind"]}</span></div>', unsafe_allow_html=True)
            if not cov.get("pages"):
                st.caption("No pages yet.")

        with tab_borders:
            _, bg = api_get(f"/runs/{run_id}/borders")
            for grid in bg.get("grids", []):
                st.markdown(f'<span class="mono">{grid["url"]}</span> &nbsp; differs by country: <strong>{grid["differsByCountry"]}</strong> &nbsp; by device: <strong>{grid["differsByDevice"]}</strong> &nbsp; shared lines: {grid["shared"]}', unsafe_allow_html=True)
                cols = st.columns(max(1, len(grid["countries"])))
                for col, country in zip(cols, grid["countries"]):
                    with col:
                        st.markdown(f"**{country['country']}**")
                        for p in country["prices"][:8]:
                            st.markdown(f'<div class="hidden-line">{p[:120]}</div>', unsafe_allow_html=True)
                        for line in [l for l in country["uniqueToCountry"] if l not in country["prices"]][:4]:
                            st.markdown(f'<div class="surface-line">{line[:120]}</div>', unsafe_allow_html=True)
                st.dataframe([{"vantage": v["key"], "lines": v["total"], "unique": len(v["unique"]), "prices": len(v["prices"])} for v in grid["vantages"]], use_container_width=True, hide_index=True)
            if not bg.get("grids"):
                st.caption("No borders job in this run.")

        with tab_prices:
            _, pr = api_get(f"/runs/{run_id}/prices")
            rows = pr.get("rows", [])
            if rows:
                st.dataframe([{"country": r["country"] or "-", "device": r["device"], "amount": r["amount"], "currency": r["currency"], "period": r["period"], "text": r["text"][:100], "layer": r["layer"]} for r in rows], use_container_width=True, hide_index=True)
            else:
                st.caption("No price lines yet.")

        with tab_diff:
            earlier = [r["id"] for r in all_runs if r["id"] != run_id]
            base = st.selectbox("Compare with an earlier run", options=["(pick a run)"] + earlier, key=f"diffbase_{run_id}")
            if base != "(pick a run)":
                code, d = api_get(f"/runs/{run_id}/diff", **{"from": base})
                if code == 200:
                    st.markdown(f'**+{len(d["added"])}** added &nbsp; **-{len(d["removed"])}** removed &nbsp; {d["unchanged"]} unchanged &nbsp; new price lines: **{len(d["priceChanges"])}**')
                    for l in d["priceChanges"][:20]:
                        st.markdown(f'<div class="hidden-line">$ [{l["vantage"]}] {l["text"][:140]}</div>', unsafe_allow_html=True)
                    for l in [x for x in d["added"] if x not in d["priceChanges"]][:20]:
                        st.markdown(f'<div class="surface-line">+ [{l["vantage"]}] {l["text"][:140]}</div>', unsafe_allow_html=True)
                    for l in d["removed"][:20]:
                        st.markdown(f'<div class="surface-line">- [{l["vantage"]}] {l["text"][:140]}</div>', unsafe_allow_html=True)
                else:
                    st.error(d.get("reason", code))

        with tab_matrix:
            _, mx = api_get(f"/runs/{run_id}/matrix")
            if mx.get("rows"):
                for row in mx["rows"]:
                    st.markdown(f'**{row["feature"]}** &nbsp; {row["status"]} &nbsp; <span class="muted">{row.get("value") or ""}</span>', unsafe_allow_html=True)
                    with st.expander(f"evidence ({len(row['evidence'])})"):
                        _, fd = api_get(f"/findings/{row['id']}")
                        for o in fd.get("observations", []):
                            st.markdown(f'<div class="surface-line">{o["text"][:160]}<br><span class="muted">{o["url"]} · {o["layer"]}</span></div>', unsafe_allow_html=True)
                        for a in fd.get("artifacts", []):
                            st.caption(f'artifact {a["path"]} {"available" if a["exists"] else "missing"}')
            else:
                st.caption(mx.get("note") or "No findings yet.")

        with tab_events:
            _, ev = api_get(f"/runs/{run_id}/events", format="json")
            for e in list(reversed(ev.get("events", [])))[:60]:
                data = e["event"]["data"]
                if e["type"] == "observation":
                    summary = f'{data.get("layer")} {data.get("kind")}: {str(data.get("text", ""))[:80]}'
                elif e["type"] == "job_state":
                    summary = f'{data.get("state")} job {str(data.get("jobId", ""))[:8]} {data.get("reason") or ""}'
                elif e["type"] == "handoff":
                    summary = f'{data.get("state")} {data.get("wall")} job {str(data.get("jobId", ""))[:8]}'
                elif e["type"] == "counter":
                    summary = f'{data.get("url")} missed by fetch: {data.get("missed")}'
                else:
                    summary = json.dumps(data)[:100]
                st.markdown(f'<div class="mono"><span class="muted">{e["createdAt"][11:19]}</span> <span style="color:#2563eb">{e["type"]}</span> {summary}</div>', unsafe_allow_html=True)

        st.divider()

    # ---------------- chat over observations ----------------
    if st.session_state.active_runs:
        st.markdown("##### Ask the research")
        for msg in st.session_state.chat_messages:
            with st.chat_message(msg["role"]):
                st.markdown(msg["content"], unsafe_allow_html=True)
        if query := st.chat_input("Search what Periscope found (words are matched against text, url and the revealing action)"):
            st.session_state.chat_messages.append({"role": "user", "content": query})
            parts = []
            for run_id in st.session_state.active_runs:
                _, res = api_get(f"/runs/{run_id}/observations", q=query, limit=15)
                for o in res.get("observations", []):
                    via = (o.get("revealedBy") or {}).get("label") or ""
                    cls = "hidden-line" if o.get("missedByFetch") else "surface-line"
                    parts.append(f'<div class="{cls}">{o["text"][:220]}<br><span class="muted">{o["competitor"]} · {o["layer"]} · {o["url"]}{" · via " + via if via else ""}</span></div>')
            answer = f"**{len(parts)}** matching observations\n" + "\n".join(parts) if parts else "Nothing matched. Try fewer words."
            st.session_state.chat_messages.append({"role": "assistant", "content": answer})
            st.rerun()

        c_back, c_live = st.columns([1, 1])
        with c_back:
            if st.button("Back to all runs"):
                st.session_state.active_runs = []
                st.session_state.chat_messages = []
                st.rerun()
        with c_live:
            st.session_state.live = st.toggle("Auto refresh while running", value=st.session_state.live)

    if st.session_state.active_runs and any_live and st.session_state.live:
        time.sleep(2)
        st.rerun()

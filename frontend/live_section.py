"""
The centre of the main page: every Steel browser the agents hold right now, embedded as Steel's live player, the
stream of what the logic does with what they see, an explicit "Steel usage" trace (each browser opened, the country
it came through Steel's proxy from, device emulation, saved logins, CAPTCHA solver attempts, human handoffs), and
under it the intelligence Periscope produced: coverage, countries, prices, feature matrix.

API only (docs/api.md): GET /sessions, /handoffs, /runs, /runs/:id, /runs/:id/events?format=json, /runs/:id/coverage,
/runs/:id/borders, /runs/:id/prices, /runs/:id/matrix; POST /runs, /jobs/:id/resume.
"""

import os
import re
import time
import uuid
from datetime import datetime, timezone

import requests
import streamlit as st
import streamlit.components.v1 as components

API = os.environ.get("PERISCOPE_API_URL", "http://localhost:4747").rstrip("/")
TARGET = os.environ.get("PERISCOPE_TARGET_URL", "").rstrip("/")  # public url of Helix Ledger; Steel's browsers run in the cloud
TARGET_EMAIL = os.environ.get("PERISCOPE_TARGET_EMAIL", "test@test.com")
COUNTRY_NAMES = {"CA": "Canada", "US": "United States", "DE": "Germany", "GB": "United Kingdom", "FR": "France", "JP": "Japan", "AU": "Australia", "IN": "India", "BR": "Brazil"}

CSS = """
<style>
.lv-wrap{margin-top:.2rem}
.lv-cap{font-family:'SF Mono','Fira Code',monospace;font-size:.78rem;color:#9aa4b2;margin:.1rem 0 .25rem 0}
.lv-tag{display:inline-block;padding:.05rem .45rem;border-radius:.4rem;background:#1f2a37;color:#dbe4ee;font-size:.7rem;margin-right:.3rem}
.lv-tag.red{background:#4a1d1d;color:#ffb4b4}.lv-tag.green{background:#173a2a;color:#a8f0c6}.lv-tag.blue{background:#1d2a4a;color:#b4c8ff}.lv-tag.steel{background:#2b2140;color:#d9c8ff}
.lv-log{font-family:'SF Mono','Fira Code',monospace;font-size:.76rem;line-height:1.45;white-space:pre-wrap;max-height:420px;overflow:auto;border:1px solid #2a3340;border-radius:6px;padding:.5rem .7rem}
.lv-log .h{color:#ffb4b4}.lv-log .c{color:#a8f0c6}.lv-log .w{color:#ffd58a}.lv-log .d{color:#9aa4b2}.lv-log .b{color:#b4c8ff}.lv-log .s{color:#d9c8ff}
.lv-chip{display:inline-block;padding:.35rem .7rem;border-radius:.5rem;background:#161c26;border:1px solid #2a3340;margin:0 .4rem .4rem 0;font-size:.85rem}
.lv-chip b{font-size:1.15rem;color:#d9c8ff;margin-right:.25rem}
.lv-empty{border:1px dashed #2a3340;border-radius:8px;padding:2.2rem 1rem;text-align:center;color:#6b7280}
</style>
"""


# ---------------------------------------------------------------------------------------------------------------
# API helpers
# ---------------------------------------------------------------------------------------------------------------
def _get(path, **params):
    try:
        r = requests.get(API + path, params=params, timeout=10)
        return r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
    except Exception:  # noqa: BLE001
        return {}


def _post(path, body=None, headers=None):
    try:
        r = requests.post(API + path, json=body or {}, headers=headers or {}, timeout=30)
        return r.status_code, r.json()
    except Exception as e:  # noqa: BLE001
        return 0, {"ok": False, "reason": str(e)}


def launch_helix_demo(target: str) -> list[str]:
    """Three runs at once on the test SaaS: parse the pricing page, see it from three countries, walk in past the login."""
    stamp = time.strftime("%H%M%S")
    runs = [
        {"competitor": "helix-ledger", "url": target, "pages": ["/pricing", "/regulatory", "/security"], "jobs": ["surface", "benchmark", "reveal"], "runId": f"helix-parse-{stamp}"},
        {"competitor": "helix-ledger", "url": target, "pages": ["/pricing"], "jobs": ["surface", "borders"], "countries": ["CA", "US", "DE"], "runId": f"helix-borders-{stamp}"},
        # accountRef trial1: Steel injects the credential stored in its vault for this account, the walker signs in by itself
        {"competitor": "helix-ledger", "url": target, "jobs": ["walker"], "start": f"{target}/sign-in", "countries": ["CA"], "accountRef": "trial1", "runId": f"helix-login-{stamp}"},
    ]
    launched = []
    for body in runs:
        code, res = _post("/runs", body, {"idempotency-key": str(uuid.uuid4())})
        if res.get("ok"):
            launched.append(res["runId"])
        else:
            st.error(f"{body['runId']}: {res.get('reason', f'HTTP {code}')}")
    return launched


# ---------------------------------------------------------------------------------------------------------------
# Steel usage trace: synthesised from the sessions the API reports, kept across refreshes in session state
# ---------------------------------------------------------------------------------------------------------------
def _now() -> str:
    return datetime.now(timezone.utc).strftime("%H:%M:%S")


def _country(v: dict) -> str:
    c = v.get("country")
    return f"{COUNTRY_NAMES.get(c, c)} through a Steel proxy" if c else "Steel's home region"


def _steel_trace(sessions: list[dict], handoffs: list[dict]) -> tuple[list[str], dict]:
    seen: dict = st.session_state.setdefault("lv_seen", {})
    trace: list[str] = st.session_state.setdefault("lv_trace", [])
    stats: dict = st.session_state.setdefault("lv_stats", {"browsers": 0, "countries": set(), "devices": set(), "proxies": 0, "logins": 0, "walls": 0, "captcha": 0})
    live_ids = {s["sessionId"] for s in sessions}
    for s in sessions:
        sid = s["sessionId"]
        if sid in seen:
            continue
        v = s.get("vantage") or {}
        seen[sid] = {"t": time.time(), "purpose": s.get("purpose"), "competitor": s.get("competitor")}
        stats["browsers"] += 1
        stats["devices"].add(v.get("device", "desktop"))
        if v.get("country"):
            stats["countries"].add(v["country"])
            stats["proxies"] += 1
        parts = [f"Steel opened browser #{stats['browsers']} for {s.get('competitor') or 'a target'}", f"purpose {s.get('purpose') or 'session'}", _country(v)]
        parts.append("mobile device emulation" if v.get("device") == "mobile" else "desktop")
        if s.get("accountRef"):
            parts.append("saved login: Steel profile restored and credentials injected, never seen by the model")
            stats["logins"] += 1
        elif s.get("purpose") == "walker":
            parts.append("Steel keeps this session's profile so the login survives for later walks")
        trace.append(f"<span class='s'>{_now()} {' · '.join(parts)} · session {sid[:8]}</span>")
    for sid, info in list(seen.items()):
        if sid not in live_ids and not info.get("closed"):
            info["closed"] = True
            trace.append(f"<span class='d'>{_now()} Steel released browser {sid[:8]} after {int(time.time() - info['t'])} s ({info.get('purpose')})</span>")
    for h in handoffs:
        key = f"{h['jobId']}:{h['generation']}"
        if key not in seen:
            seen[key] = {"t": time.time(), "closed": True}
            stats["walls"] += 1
            trace.append(f"<span class='h'>{_now()} {h['wall'].upper()} wall: the session is kept alive, a human takes over in Steel's live view, the walk resumes in the same browser</span>")
    return trace, stats


def _event_line(e: dict, stats: dict) -> str | None:
    ev = e.get("event", {})
    t = ev.get("type")
    d = ev.get("data", {})
    ts = e.get("createdAt", "")[11:19]
    if t == "job_state":
        reason = d.get("reason") or ""
        state = d.get("state")
        if "captcha" in reason:
            outcome = reason.split(":")[-1]
            key = f"captcha:{d.get('jobId')}:{outcome}"
            if key not in st.session_state.get("lv_seen", {}):
                st.session_state.setdefault("lv_seen", {})[key] = {"closed": True}
                stats["captcha"] += 1
            return f"<span class='w'>{ts} Steel CAPTCHA solver ran first: {outcome} (job {d.get('jobId', '')[:8]})</span>"
        cls = "w" if state in ("awaiting_human", "partial", "failed") else "d"
        return f"<span class='{cls}'>{ts} job {d.get('jobId', '')[:8]} {state}{' (' + reason + ')' if reason else ''}</span>"
    if t == "handoff":
        return f"<span class='h'>{ts} WALL {d.get('wall')} → {d.get('state')} (generation {d.get('generation')})</span>"
    if t == "counter":
        return f"<span class='c'>{ts} COUNTER {d.get('url')} · missed by fetch: {d.get('missed')}</span>"
    if t == "observation" and d.get("layer") in ("hidden", "interior", "borders"):
        rb = d.get("revealedBy") or {}
        via = rb.get("label") or (rb.get("action") if rb.get("action") not in (None, "none") else "") or ""
        v = d.get("vantage") or {}
        where = f" from {COUNTRY_NAMES.get(v.get('country'), v.get('country'))}{' on mobile' if v.get('device') == 'mobile' else ''}" if v.get("country") else ""
        flag = "<span class='c'> ✗ fetch never saw this</span>" if d.get("missedByFetch") else ""
        layer = {"hidden": "b", "interior": "c", "borders": "d"}.get(d.get("layer"), "d")
        return f"<span class='d'>{ts}</span> <span class='{layer}'>[{d.get('layer')}{where}]</span> {(via + ' → ') if via else ''}{d.get('text', '')[:120]}{flag}"
    if t == "run_done":
        return f"<span class='c'>{ts} RUN DONE</span>"
    return None



# ---------------------------------------------------------------------------------------------------------------
# One compact story per run: what the agent did, in sentences, with every Steel feature as a badge
# ---------------------------------------------------------------------------------------------------------------
_PRICE = re.compile(r"(\$|€|£|CA\$)\s?\d|\d+([.,]\d+)?\s?(€|EUR)")
STORY_CSS = """
<style>
.story{border:1px solid #2a3340;border-radius:8px;padding:.6rem .8rem;margin:0 0 .6rem 0;background:#0f141b}
.story .h{font-weight:600;margin-bottom:.3rem}
.story .l{font-size:.85rem;color:#c9d1d9;padding:.12rem 0;line-height:1.4}
.story .l b{color:#ffb4b4}.story .ok{color:#a8f0c6}.story .warn{color:#ffd58a}.story .mut{color:#6b7280}
.story .steel{display:inline-block;padding:.02rem .4rem;border-radius:.4rem;background:#2b2140;color:#d9c8ff;font-size:.7rem;margin-left:.25rem}
</style>
"""

VERBS = {"toggle": "flipped", "click": "opened", "select": "selected", "hover": "hovered", "scroll": "scrolled to", "none": "read"}


def _seconds(run: dict) -> str:
    try:
        r = run["run"]
        a = datetime.fromisoformat(r["createdAt"].replace("Z", "+00:00"))
        b = datetime.fromisoformat(r["updatedAt"].replace("Z", "+00:00"))
        return f" · {int((b - a).total_seconds())} s"
    except Exception:  # noqa: BLE001
        return ""


def _story_card(rid: str, stats: dict) -> None:
    run = _get(f"/runs/{rid}")
    if not run.get("ok"):
        return
    events = _get(f"/runs/{rid}/events", format="json").get("events", [])
    jobs = run.get("jobs") or []
    purposes = sorted({j.get("purpose") for j in jobs if j.get("purpose")})
    kind = "LOG IN" if "walker" in purposes else "COUNTRIES" if "borders" in purposes else "PARSE"
    status = (run.get("run") or {}).get("status", "")
    obs = [e["event"]["data"] for e in events if e.get("type") == "observation"]
    hidden = [o for o in obs if o.get("layer") == "hidden"]
    borders = [o for o in obs if o.get("layer") == "borders"]
    interior = [o for o in obs if o.get("layer") == "interior"]
    countries = sorted({(o.get("vantage") or {}).get("country") for o in obs if (o.get("vantage") or {}).get("country")})
    devices = sorted({(o.get("vantage") or {}).get("device", "desktop") for o in obs})
    counters: dict = {}
    for e in events:
        if e.get("type") == "counter":
            d = e["event"]["data"]
            if isinstance(d.get("missed"), int):
                counters[d["url"]] = max(counters.get(d["url"], 0), d["missed"])
    handoffs = [e["event"]["data"] for e in events if e.get("type") == "handoff"]
    captcha = [e["event"]["data"]["reason"].split(":")[-1] for e in events if e.get("type") == "job_state" and "captcha" in (e["event"]["data"].get("reason") or "")]
    seconds = _seconds(run)

    n_browsers = 6 if kind == "COUNTRIES" else 1
    badges = [f"<span class='steel'>{n_browsers} Steel browser{'s' if n_browsers > 1 else ''}</span>"]
    if countries:
        badges.append(f"<span class='steel'>Steel proxies: {' '.join(countries)}</span>")
    if "mobile" in devices:
        badges.append("<span class='steel'>device emulation</span>")
    if kind == "LOG IN":
        badges.append("<span class='steel'>profile kept</span>")
    if captcha:
        badges.append("<span class='steel'>CAPTCHA solver</span>")
    if handoffs:
        badges.append("<span class='steel'>live view handoff</span>")

    lines = []
    if kind == "PARSE":
        by_label: dict = {}
        action_of: dict = {}
        for o in hidden:
            if o.get("missedByFetch"):
                rb = o.get("revealedBy") or {}
                lbl = rb.get("label") or rb.get("action") or "page"
                by_label[lbl] = by_label.get(lbl, 0) + 1
                action_of[lbl] = rb.get("action", "click")
        for lbl, n in sorted(by_label.items(), key=lambda kv: -kv[1])[:5]:
            lines.append(f"<div class='l'>{VERBS.get(action_of.get(lbl), 'used')} <b>{lbl[:40]}</b> → {n} line{'s' if n != 1 else ''} a fetch tool never saw</div>")
        total = sum(counters.values())
        if total:
            lines.append(f"<div class='l ok'>✓ {total} lines missed by fetch across {len(counters)} page{'s' if len(counters) != 1 else ''}{seconds}</div>")
        elif status == "running":
            lines.append("<div class='l mut'>reading the page, then clicking everything a fetch tool cannot…</div>")
        else:
            lines.append("<div class='l mut'>this run did not finish its reveal (Steel session limit reached while other runs were open); press the button again</div>")
    elif kind == "COUNTRIES":
        by_c: dict = {}
        for o in borders:
            c = (o.get("vantage") or {}).get("country")
            if c and _PRICE.search(o.get("text", "")):
                by_c.setdefault(c, [])
                if o["text"] not in by_c[c] and len(by_c[c]) < 3:
                    by_c[c].append(o["text"])
        for c, prices in by_c.items():
            lines.append(f"<div class='l'>from <b>{COUNTRY_NAMES.get(c, c)}</b> through a Steel proxy: {' · '.join(x[:26] for x in prices)}</div>")
        if len(by_c) > 1:
            lines.append(f"<div class='l ok'>✓ prices differ by country, seen in {len(borders)} lines from 6 browsers at once{seconds}</div>")
        elif status == "running":
            lines.append("<div class='l mut'>opening six browsers in three countries…</div>")
    else:
        logins = [e["event"]["data"]["reason"] for e in events if e.get("type") == "job_state" and (e["event"]["data"].get("reason") or "").startswith("login:")]
        if logins:
            badges.append("<span class='steel'>credentials vault</span>")
            lines.append("<div class='l ok'>🔑 Steel injected the stored credentials from its vault, the anti-bot box was cleared in the browser, <b>signed in without a human</b>. The model never saw the password.</div>")
        if handoffs:
            last = handoffs[-1]
            state = last.get("state")
            msg = {"awaiting_human": "waiting for a human in Steel's live view", "resumed": "a human cleared it, the walk resumed in the same browser", "abandoned": "nobody cleared it in time"}.get(state, state)
            lines.append(f"<div class='l warn'>⛔ {last.get('wall')} wall → {msg}</div>")
        if captcha:
            lines.append(f"<div class='l'>Steel CAPTCHA solver ran first: <b>{captcha[-1]}</b></div>")
        if interior:
            pages = sorted({o.get("url", "").rstrip("/").split("/")[-1] or "dashboard" for o in interior})
            lines.append(f"<div class='l ok'>✓ inside: {len(interior)} facts from {len(pages)} screens ({', '.join(pages[:6])})</div>")
            for o in interior[:3]:
                lines.append(f"<div class='l mut'>{o.get('text', '')[:90]}</div>")
        if not handoffs and not interior:
            lines.append("<div class='l mut'>opening the sign-in page…</div>")
    competitor = (jobs[0].get("competitor") if jobs else "") or ""
    st.markdown(STORY_CSS + f"<div class='story'><div class='h'><span class='lv-tag blue'>{kind}</span> {competitor} {''.join(badges)} <span class='mut'>· {status}</span></div>" + "".join(lines) + "</div>", unsafe_allow_html=True)

# ---------------------------------------------------------------------------------------------------------------
# Intelligence under the live view
# ---------------------------------------------------------------------------------------------------------------
def _intelligence(run_ids: list[str]) -> None:
    st.markdown("##### What Periscope learned")
    st.markdown('<span class="muted">Coverage, countries, prices and the feature matrix from the runs above. Every row links back to the observation and the Steel session that produced it.</span>', unsafe_allow_html=True)
    if not run_ids:
        st.markdown('<div class="lv-empty">Nothing yet. Launch the demo above.</div>', unsafe_allow_html=True)
        return
    tab_cov, tab_borders, tab_prices, tab_matrix = st.tabs(["Coverage", "Countries", "Prices", "Feature matrix"])
    with tab_cov:
        rows = []
        for rid in run_ids:
            cov = _get(f"/runs/{rid}/coverage")
            for p in cov.get("pages", []):
                top = ", ".join(f"{k} ({v})" for k, v in sorted((p.get("byAction") or {}).items(), key=lambda kv: -kv[1])[:4])
                rows.append({"page": p["url"], "fetch saw": p["surface"], "revealed": p["hidden"], "missed by fetch": p["counter"], "documents": p["documents"], "vantages": len(p["vantages"]), "revealed by": top})
        if rows:
            st.dataframe(rows, use_container_width=True, hide_index=True)
        else:
            st.markdown('<span class="muted">No pages yet.</span>', unsafe_allow_html=True)
    with tab_borders:
        shown = False
        for rid in run_ids:
            for g in _get(f"/runs/{rid}/borders").get("grids", []):
                shown = True
                st.markdown(f"<span class='mono'>{g['url']}</span> · differs by country: <strong>{'yes' if g['differsByCountry'] else 'no'}</strong> · differs by device: <strong>{'yes' if g['differsByDevice'] else 'no'}</strong>", unsafe_allow_html=True)
                cols = st.columns(max(1, len(g.get("countries", []))))
                for i, c in enumerate(g.get("countries", [])):
                    with cols[i % len(cols)]:
                        st.markdown(f"**{COUNTRY_NAMES.get(c['country'], c['country'])}** <span class='lv-tag steel'>via Steel proxy</span>", unsafe_allow_html=True)
                        for line in c.get("prices", [])[:6]:
                            st.markdown(f"<div class='hidden-line'>{line[:120]}</div>", unsafe_allow_html=True)
                        for line in [l for l in c.get("uniqueToCountry", []) if l not in c.get("prices", [])][:4]:
                            st.markdown(f"<div class='surface-line'>{line[:120]}</div>", unsafe_allow_html=True)
        if not shown:
            st.markdown('<span class="muted">No border run yet.</span>', unsafe_allow_html=True)
    with tab_prices:
        rows = []
        for rid in run_ids:
            for r in _get(f"/runs/{rid}/prices").get("rows", []):
                rows.append({"country": COUNTRY_NAMES.get(r["country"], r["country"] or "home"), "device": r["device"], "amount": r["amount"], "currency": r["currency"], "period": r["period"], "text": r["text"][:90], "layer": r["layer"]})
        if rows:
            st.dataframe(rows, use_container_width=True, hide_index=True)
        else:
            st.markdown('<span class="muted">No price lines yet.</span>', unsafe_allow_html=True)
    with tab_matrix:
        rows = []
        note = None
        for rid in run_ids:
            m = _get(f"/runs/{rid}/matrix")
            note = note or m.get("note")
            for r in m.get("rows", []):
                rows.append({"competitor": r["competitor"], "feature": r["feature"], "status": r["status"], "value": (r.get("value") or "")[:100], "evidence": len(r.get("evidence") or [])})
        if rows:
            st.dataframe(rows, use_container_width=True, hide_index=True)
        else:
            st.markdown(f'<span class="muted">{note or "The matrix fills a minute after a run completes (one Claude call per competitor)."}</span>', unsafe_allow_html=True)


# ---------------------------------------------------------------------------------------------------------------
# Section
# ---------------------------------------------------------------------------------------------------------------
def render_live_section(followed_runs: list[str] | None = None, on_launch=None) -> None:
    st.markdown(CSS, unsafe_allow_html=True)
    st.markdown("### Live: the agents at work on Steel")
    st.markdown('<span class="muted">Every frame is a real Steel browser, streamed as it runs. One instance parses the pricing page, six see it from three countries through Steel proxies, one walks in past the login. The trace on the right names every Steel feature as it is used.</span>', unsafe_allow_html=True)

    health = _get("/health")
    if not health.get("steel"):
        st.info("The API has no Steel key, so nothing can be launched from here.")
        return

    c1, c2 = st.columns([2, 3])
    with c1:
        target = st.text_input("Target (the team's test SaaS, Helix Ledger)", value=TARGET, placeholder="https://<words>.trycloudflare.com", key="lv_target")
    with c2:
        st.markdown("<div style='height:1.7rem'></div>", unsafe_allow_html=True)
        disabled = not target.startswith("http") or "localhost" in target or "127.0.0.1" in target
        if st.button("Run the Helix Ledger demo: parse, three countries, and log in", type="primary", disabled=disabled, use_container_width=True, key="lv_launch"):
            ids = launch_helix_demo(target.rstrip("/"))
            if ids:
                st.session_state["lv_runs"] = ids
                if on_launch:
                    on_launch(target.rstrip("/"))
                st.toast(f"Launched {len(ids)} runs")
        if disabled and target:
            st.caption("Steel's browsers run in the cloud, so the target must be a public url, not localhost.")
    st.caption(f"Login beat: the walker stops at the sign-in wall and the card turns red; a teammate types {TARGET_EMAIL} and the password inside the live frame, then presses resume. Periscope never sees the password.")

    followed = list(followed_runs or []) or list(st.session_state.get("lv_runs", []))
    if not followed:
        # default to the latest Helix runs so the page is never empty
        followed = [r["id"] for r in _get("/runs", limit=30).get("runs", []) if "helix-ledger" in (r.get("competitors") or [])][:3]

    @st.fragment(run_every="2s")
    def live_body():
        sessions = _get("/sessions").get("sessions", [])
        handoffs = _get("/handoffs").get("handoffs", [])
        trace, stats = _steel_trace(sessions, handoffs)

        chips = [
            f"<span class='lv-chip'><b>{stats['browsers']}</b> Steel browsers opened</span>",
            f"<span class='lv-chip'><b>{len(stats['countries'])}</b> countries via Steel proxies {'(' + ', '.join(sorted(stats['countries'])) + ')' if stats['countries'] else ''}</span>",
            f"<span class='lv-chip'><b>{len(stats['devices'])}</b> device profiles</span>",
            f"<span class='lv-chip'><b>{stats['captcha']}</b> CAPTCHA solver runs</span>",
            f"<span class='lv-chip'><b>{stats['walls']}</b> human handoffs in the live view</span>",
            f"<span class='lv-chip'><b>{len(sessions)}</b> live now</span>",
        ]
        st.markdown("".join(chips), unsafe_allow_html=True)

        left, right = st.columns([3, 2], gap="medium")
        with left:
            if not sessions:
                st.markdown('<div class="lv-empty">No Steel browser open right now. Press the red button; browsers appear here within seconds.</div>', unsafe_allow_html=True)
            n = len(sessions)
            ncols = 3 if n >= 5 else 2 if n > 1 else 1
            cols = st.columns(ncols) if n > 1 else [st.container()]
            for i, s in enumerate(sessions):
                with cols[i % len(cols)]:
                    v = s.get("vantage") or {}
                    tags = [f"<span class='lv-tag blue'>{s.get('purpose') or 'session'}</span>", f"<span class='lv-tag steel'>{COUNTRY_NAMES.get(v.get('country'), v.get('country')) + ' · proxy' if v.get('country') else 'home region'}</span>", f"<span class='lv-tag'>{v.get('device', 'desktop')}</span>"]
                    if s.get("accountRef"):
                        tags.append("<span class='lv-tag green'>signed in</span>")
                    if s.get("pendingWall"):
                        tags.append(f"<span class='lv-tag red'>wall: {s['pendingWall']} · needs a human</span>")
                    st.markdown(f"<div class='lv-cap'><strong>{s.get('competitor') or ''}</strong> {''.join(tags)}<br>{(s.get('currentUrl') or '')[:80]}</div>", unsafe_allow_html=True)
                    components.iframe(s["playerUrl"], height=300 if ncols == 3 else 340)
                    st.markdown(f"<div class='lv-cap'>Steel session {s['sessionId'][:8]} · <a href='{s['viewerUrl']}' target='_blank'>open in Steel</a></div>", unsafe_allow_html=True)

        with right:
            for h in handoffs:
                st.error(f"{h['wall']} wall on job {h['jobId'][:8]}: clear it in the live frame, then resume.")
                if st.button("I cleared it, resume", key=f"lv_resume_{h['jobId']}"):
                    code, res = _post(f"/jobs/{h['jobId']}/resume", {"generation": h["generation"]})
                    st.toast("Resumed" if res.get("ok") else res.get("reason", f"HTTP {code}"))
            st.markdown("**Steel usage trace**")
            st.markdown("<div class='lv-log'>" + ("<br>".join(trace[-40:][::-1]) or "<span class='d'>Waiting for the first browser.</span>") + "</div>", unsafe_allow_html=True)

            st.markdown("**What the logic is doing**")
            order = {"parse": 0, "borders": 1, "login": 2}
            for rid in sorted(followed, key=lambda r: order.get(r.split("-")[1] if "-" in r else "", 9)):
                _story_card(rid, stats)

    live_body()

    st.divider()

    @st.fragment(run_every="10s")
    def intel_body():
        _intelligence(followed)

    intel_body()

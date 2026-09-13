"""
Periscope live view: every Steel browser the agents hold right now, embedded as a live WebRTC player, next to the
stream of what the logic is doing (job states, CAPTCHA solving, walls, resumes, what fetch never saw).

Runs against the API only (docs/api.md): GET /sessions, GET /runs/:id/events?format=json, GET /handoffs,
POST /jobs/:id/resume, POST /runs. Nothing here touches Steel or SQLite directly.
"""

import os
import time
import uuid

import requests
import streamlit as st
import streamlit.components.v1 as components

API = os.environ.get("PERISCOPE_API_URL", "http://localhost:4747").rstrip("/")
st.set_page_config(page_title="Periscope live", layout="wide")
st.markdown(
    """
<style>
.block-container{padding-top:1.2rem}
.cap{font-family:ui-monospace,monospace;font-size:0.8rem;color:#9aa4b2;margin:0 0 .25rem 0}
.tag{display:inline-block;padding:.1rem .45rem;border-radius:.4rem;background:#1f2a37;color:#dbe4ee;font-size:.72rem;margin-right:.3rem}
.tag.red{background:#4a1d1d;color:#ffb4b4}
.tag.green{background:#173a2a;color:#a8f0c6}
.log{font-family:ui-monospace,monospace;font-size:.78rem;line-height:1.35;white-space:pre-wrap}
.log .h{color:#ffb4b4}.log .c{color:#a8f0c6}.log .w{color:#ffd58a}.log .d{color:#9aa4b2}
</style>
""",
    unsafe_allow_html=True,
)


def api_get(path, **params):
    try:
        r = requests.get(API + path, params=params, timeout=10)
        return r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
    except Exception:  # noqa: BLE001
        return {}


def api_post(path, body=None, headers=None):
    try:
        r = requests.post(API + path, json=body or {}, headers=headers or {}, timeout=30)
        return r.status_code, r.json()
    except Exception as e:  # noqa: BLE001
        return 0, {"ok": False, "reason": str(e)}


st.title("Periscope, live")
st.caption("Every browser below is a real Steel session driven by the agents. Left: the browsers. Right: the logic, as it happens.")

health = api_get("/health")
if not health.get("ok"):
    st.error(f"API not reachable at {API}. Start it with `npm run api`.")
    st.stop()
if not health.get("steel"):
    st.warning("The API has no STEEL_API_KEY, so nothing can be launched from here.")

# ---- launch strip ---------------------------------------------------------------------------------------------
with st.expander("Launch", expanded=not api_get("/sessions").get("sessions")):
    c1, c2, c3, c4 = st.columns([1.2, 2, 1.6, 1])
    competitor = c1.text_input("Competitor", value="spotify")
    url = c2.text_input("Site", value="https://www.spotify.com")
    pages = c3.text_input("Pages", value="/premium/")
    countries = c4.text_input("Countries", value="CA,US,DE")
    jobs = st.multiselect("Jobs", ["surface", "benchmark", "reveal", "borders", "walker"], default=["surface", "benchmark", "reveal", "borders"])
    start = st.text_input("Walker start url (the page after login, or a login page: the walker stops at the wall and waits for you in the live view)", value="")
    b1, b2 = st.columns([1, 5])
    if b1.button("Run live", type="primary", use_container_width=True):
        body = {"competitor": competitor.strip(), "url": url.strip(), "pages": [p.strip() for p in pages.split(",") if p.strip()], "jobs": jobs,
                "countries": [c.strip() for c in countries.split(",") if c.strip()], "runId": f"live-{competitor.strip()}-{time.strftime('%H%M%S')}"}
        if start.strip():
            body["start"] = start.strip()
        code, res = api_post("/runs", body, {"idempotency-key": str(uuid.uuid4())})
        if res.get("ok"):
            st.session_state["live_run"] = res["runId"]
            b2.success(f"Run {res['runId']} launched")
        else:
            b2.error(res.get("reason", f"HTTP {code}"))

run_id = st.session_state.get("live_run")
runs = api_get("/runs", limit=15).get("runs", [])
options = [r["id"] for r in runs]
if run_id and run_id not in options:
    options.insert(0, run_id)
if options:
    run_id = st.selectbox("Run to follow", options, index=options.index(run_id) if run_id in options else 0)
    st.session_state["live_run"] = run_id


# ---- live fragment --------------------------------------------------------------------------------------------
@st.fragment(run_every="2s")
def live():
    sessions = api_get("/sessions").get("sessions", [])
    handoffs = api_get("/handoffs").get("handoffs", [])
    left, right = st.columns([2, 1])

    with left:
        st.subheader(f"{len(sessions)} live browser{'s' if len(sessions) != 1 else ''}")
        if not sessions:
            st.info("No Steel session open right now. Launch a run above; browsers appear here within seconds.")
        cols = st.columns(2) if len(sessions) > 1 else [st.container()]
        for i, s in enumerate(sessions):
            with cols[i % len(cols)]:
                v = s.get("vantage") or {}
                tags = [f"<span class='tag'>{s.get('purpose') or 'session'}</span>", f"<span class='tag'>{v.get('country') or 'home'} · {v.get('device', 'desktop')}</span>"]
                if s.get("profileId") or s.get("accountRef"):
                    tags.append("<span class='tag green'>signed in</span>")
                elif s.get("purpose") == "walker":
                    tags.append("<span class='tag'>walker, no account yet</span>")
                if s.get("pendingWall"):
                    tags.append(f"<span class='tag red'>wall: {s['pendingWall']} — needs you</span>")
                st.markdown(f"<div class='cap'>{s.get('competitor') or ''} {''.join(tags)}<br>{(s.get('currentUrl') or '')[:90]}</div>", unsafe_allow_html=True)
                components.iframe(s["playerUrl"], height=360)
                st.markdown(f"<div class='cap'>session {s['sessionId'][:8]} · <a href='{s['viewerUrl']}' target='_blank'>open in Steel</a></div>", unsafe_allow_html=True)

    with right:
        st.subheader("What the logic is doing")
        if handoffs:
            for h in handoffs:
                st.error(f"{h['wall']} wall on job {h['jobId'][:8]}. Clear it in the live view, then:")
                if st.button("I cleared it, resume", key=f"live_resume_{h['jobId']}"):
                    code, res = api_post(f"/jobs/{h['jobId']}/resume", {"generation": h["generation"]})
                    st.toast("Resumed" if res.get("ok") else res.get("reason", f"HTTP {code}"))
        if not run_id:
            st.info("Pick a run to follow.")
            return
        run = api_get(f"/runs/{run_id}")
        counters = run.get("counters") or []
        missed = sum(c["missed"] for c in counters if isinstance(c.get("missed"), int))
        m1, m2, m3 = st.columns(3)
        m1.metric("Missed by fetch", missed)
        m2.metric("Observations", (run.get("counts") or {}).get("observations", 0))
        m3.metric("Status", (run.get("run") or {}).get("status", "?"))
        events = api_get(f"/runs/{run_id}/events", format="json").get("events", [])
        lines = []
        for e in events[-400:]:
            ev = e.get("event", {})
            t = ev.get("type")
            d = ev.get("data", {})
            ts = e.get("createdAt", "")[11:19]
            if t == "job_state":
                reason = d.get("reason")
                cls = "w" if d.get("state") in ("awaiting_human", "partial", "failed") else "d"
                extra = f" ({reason})" if reason else ""
                if reason and "captcha" in reason:
                    cls = "w"
                    extra = f"  ← Steel CAPTCHA solver: {reason.split(':')[-1]}"
                lines.append(f"<span class='{cls}'>{ts} job {d.get('jobId', '')[:8]} {d.get('state')}{extra}</span>")
            elif t == "handoff":
                lines.append(f"<span class='h'>{ts} WALL {d.get('wall')} → {d.get('state')} (generation {d.get('generation')})</span>")
            elif t == "counter":
                lines.append(f"<span class='c'>{ts} COUNTER {d.get('url')} missed by fetch: {d.get('missed')}</span>")
            elif t == "observation":
                if d.get("layer") in ("hidden", "interior", "borders"):
                    via = (d.get("revealedBy") or {}).get("label") or (d.get("revealedBy") or {}).get("action") or ""
                    flag = " ✗fetch" if d.get("missedByFetch") else ""
                    vc = (d.get("vantage") or {}).get("country") or ""
                    lines.append(f"<span class='d'>{ts}</span> [{d.get('layer')}{' ' + vc if vc else ''}] {via + ': ' if via else ''}{d.get('text', '')[:110]}<span class='c'>{flag}</span>")
            elif t == "run_done":
                lines.append(f"<span class='c'>{ts} RUN DONE</span>")
        st.markdown("<div class='log'>" + "<br>".join(lines[-120:][::-1]) + "</div>", unsafe_allow_html=True)


live()

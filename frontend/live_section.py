"""
Live section for the main page: every Steel browser the agents hold right now, embedded as Steel's live player, next
to the stream of what the logic is doing, plus a one-click launcher for the Helix Ledger demo (the team's test SaaS):
one instance parses the pricing page (toggles, dropdowns, hover, accordion, iframe, hidden API), six instances see it
from three countries, and one instance walks in through the login wall and reads the dashboard.

API only (docs/api.md): GET /sessions, /handoffs, /runs/:id, /runs/:id/events?format=json, POST /runs, /jobs/:id/resume.
"""

import os
import time
import uuid

import requests
import streamlit as st
import streamlit.components.v1 as components

API = os.environ.get("PERISCOPE_API_URL", "http://localhost:4747").rstrip("/")
TARGET = os.environ.get("PERISCOPE_TARGET_URL", "").rstrip("/")  # public url of Helix Ledger; Steel's browsers run in the cloud
TARGET_EMAIL = os.environ.get("PERISCOPE_TARGET_EMAIL", "test@test.com")

CSS = """
<style>
.lv-cap{font-family:'SF Mono','Fira Code',monospace;font-size:.78rem;color:#9aa4b2;margin:.1rem 0 .25rem 0}
.lv-tag{display:inline-block;padding:.05rem .45rem;border-radius:.4rem;background:#1f2a37;color:#dbe4ee;font-size:.7rem;margin-right:.3rem}
.lv-tag.red{background:#4a1d1d;color:#ffb4b4}.lv-tag.green{background:#173a2a;color:#a8f0c6}.lv-tag.blue{background:#1d2a4a;color:#b4c8ff}
.lv-log{font-family:'SF Mono','Fira Code',monospace;font-size:.76rem;line-height:1.4;white-space:pre-wrap;max-height:520px;overflow:auto}
.lv-log .h{color:#ffb4b4}.lv-log .c{color:#a8f0c6}.lv-log .w{color:#ffd58a}.lv-log .d{color:#9aa4b2}.lv-log .b{color:#b4c8ff}
</style>
"""


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
        {"competitor": "helix-ledger", "url": target, "jobs": ["walker"], "start": f"{target}/sign-in", "countries": ["CA"], "runId": f"helix-login-{stamp}"},
    ]
    launched = []
    for body in runs:
        code, res = _post("/runs", body, {"idempotency-key": str(uuid.uuid4())})
        if res.get("ok"):
            launched.append(res["runId"])
        else:
            st.error(f"{body['runId']}: {res.get('reason', f'HTTP {code}')}")
    return launched


def _event_line(e: dict) -> str | None:
    ev = e.get("event", {})
    t = ev.get("type")
    d = ev.get("data", {})
    ts = e.get("createdAt", "")[11:19]
    if t == "job_state":
        reason = d.get("reason") or ""
        state = d.get("state")
        if "captcha" in reason:
            return f"<span class='w'>{ts} Steel CAPTCHA solver: {reason.split(':')[-1]} (job {d.get('jobId', '')[:8]})</span>"
        cls = "w" if state in ("awaiting_human", "partial", "failed") else "d"
        return f"<span class='{cls}'>{ts} job {d.get('jobId', '')[:8]} {state}{' (' + reason + ')' if reason else ''}</span>"
    if t == "handoff":
        return f"<span class='h'>{ts} WALL {d.get('wall')} → {d.get('state')} (generation {d.get('generation')})</span>"
    if t == "counter":
        return f"<span class='c'>{ts} COUNTER {d.get('url')} · missed by fetch: {d.get('missed')}</span>"
    if t == "observation" and d.get("layer") in ("hidden", "interior", "borders"):
        rb = d.get("revealedBy") or {}
        via = rb.get("label") or (rb.get("action") if rb.get("action") not in (None, "none") else "") or ""
        vc = (d.get("vantage") or {}).get("country") or ""
        flag = "<span class='c'> ✗ fetch never saw this</span>" if d.get("missedByFetch") else ""
        layer = {"hidden": "b", "interior": "green", "borders": "d"}.get(d.get("layer"), "d")
        return f"<span class='d'>{ts}</span> <span class='{layer}'>[{d.get('layer')}{' ' + vc if vc else ''}]</span> {(via + ' → ') if via else ''}{d.get('text', '')[:120]}{flag}"
    if t == "run_done":
        return f"<span class='c'>{ts} RUN DONE</span>"
    return None


def render_live_section(followed_runs: list[str] | None = None, on_launch=None) -> None:
    st.markdown(CSS, unsafe_allow_html=True)
    st.markdown("##### Live: the agents at work on Steel")
    st.markdown('<span class="muted">Every frame is a real Steel browser, streamed as it runs. Left: the browsers. Right: what the logic does with what they see.</span>', unsafe_allow_html=True)

    health = _get("/health")
    if not health.get("steel"):
        st.info("The API has no Steel key, so nothing can be launched from here.")
        return

    # ---- demo launcher -------------------------------------------------------------------------------------------
    c1, c2 = st.columns([2, 3])
    with c1:
        target = st.text_input("Helix Ledger url (public, reachable from Steel's cloud)", value=TARGET, placeholder="https://helix-ledger.example.com", key="lv_target")
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
    st.caption(f"Login beat: the walker stops at the sign-in wall; a teammate types {TARGET_EMAIL} and the password inside the live frame, then presses resume. Periscope never sees the password.")

    followed = list(followed_runs or []) or list(st.session_state.get("lv_runs", []))

    @st.fragment(run_every="2s")
    def live_body():
        sessions = _get("/sessions").get("sessions", [])
        handoffs = _get("/handoffs").get("handoffs", [])
        left, right = st.columns([3, 2], gap="medium")

        with left:
            n = len(sessions)
            st.markdown(f"**{n} live browser{'s' if n != 1 else ''}**")
            if not sessions:
                st.markdown('<span class="muted">No Steel session open right now. Launch a run; browsers appear within seconds.</span>', unsafe_allow_html=True)
            cols = st.columns(2) if n > 1 else [st.container()]
            for i, s in enumerate(sessions):
                with cols[i % len(cols)]:
                    v = s.get("vantage") or {}
                    purpose = s.get("purpose") or "session"
                    tags = [f"<span class='lv-tag blue'>{purpose}</span>", f"<span class='lv-tag'>{v.get('country') or 'home'} · {v.get('device', 'desktop')}</span>"]
                    if s.get("profileId") or s.get("accountRef"):
                        tags.append("<span class='lv-tag green'>signed in</span>")
                    if s.get("pendingWall"):
                        tags.append(f"<span class='lv-tag red'>wall: {s['pendingWall']} · needs a human</span>")
                    st.markdown(f"<div class='lv-cap'><strong>{s.get('competitor') or ''}</strong> {''.join(tags)}<br>{(s.get('currentUrl') or '')[:90]}</div>", unsafe_allow_html=True)
                    components.iframe(s["playerUrl"], height=330)
                    st.markdown(f"<div class='lv-cap'>session {s['sessionId'][:8]} · <a href='{s['viewerUrl']}' target='_blank'>open in Steel</a></div>", unsafe_allow_html=True)

        with right:
            st.markdown("**What the logic is doing**")
            for h in handoffs:
                st.error(f"{h['wall']} wall on job {h['jobId'][:8]}: clear it in the live frame, then resume.")
                if st.button("I cleared it, resume", key=f"lv_resume_{h['jobId']}"):
                    code, res = _post(f"/jobs/{h['jobId']}/resume", {"generation": h["generation"]})
                    st.toast("Resumed" if res.get("ok") else res.get("reason", f"HTTP {code}"))
            run_ids = followed or [s.get("runId") for s in sessions if s.get("runId")]
            run_ids = list(dict.fromkeys(r for r in run_ids if r))
            if not run_ids:
                st.markdown('<span class="muted">Launch the demo or a run to follow its logic here.</span>', unsafe_allow_html=True)
                return
            missed = 0
            observations = 0
            lines = []
            for rid in run_ids:
                run = _get(f"/runs/{rid}")
                by_url = {}
                for c in run.get("counters") or []:
                    if isinstance(c.get("missed"), int):
                        by_url[c.get("url")] = max(by_url.get(c.get("url"), 0), c["missed"])
                missed += sum(by_url.values())
                observations += (run.get("counts") or {}).get("observations", 0)
                for e in _get(f"/runs/{rid}/events", format="json").get("events", [])[-300:]:
                    line = _event_line(e)
                    if line:
                        lines.append((e.get("createdAt", ""), f"<span class='d'>{rid.split('-')[1] if '-' in rid else rid}</span> {line}"))
            m1, m2, m3 = st.columns(3)
            m1.metric("Missed by fetch", missed)
            m2.metric("Observations", observations)
            m3.metric("Runs", len(run_ids))
            lines.sort(key=lambda x: x[0])
            st.markdown("<div class='lv-log'>" + "<br>".join(l for _, l in lines[-150:][::-1]) + "</div>", unsafe_allow_html=True)

    live_body()

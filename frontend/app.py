"""
Periscope — Streamlit frontend.

Reads directly from the SQLite database written by the Node.js backend.
Provides: competitor list management, run triggering, live progress, and
semantic chat over the observation corpus.
"""

import json
import os
import sqlite3
import subprocess
import time
from pathlib import Path

import streamlit as st

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

DATA_DIR = os.environ.get("PERISCOPE_DATA_DIR", str(Path(__file__).resolve().parent.parent / "data"))
DB_PATH = os.path.join(DATA_DIR, "periscope.sqlite")
COMPETITORS_FILE = os.path.join(DATA_DIR, "competitors.json")
DEVICE_PASSWORD = os.environ.get("PERISCOPE_PASSWORD", "")

st.set_page_config(page_title="Periscope", layout="wide")

# ---------------------------------------------------------------------------
# Minimal custom CSS — clean, restrained styling
# ---------------------------------------------------------------------------

st.markdown("""
<style>
    /* Remove default Streamlit top padding */
    .block-container { padding-top: 2rem; }

    /* Competitor list items */
    .competitor-item {
        padding: 0.5rem 0;
        border-bottom: 1px solid #e2e2e2;
        font-family: 'SF Mono', 'Fira Code', monospace;
        font-size: 0.9rem;
        color: #1a1a1a;
    }

    /* Progress log */
    .progress-log {
        font-family: 'SF Mono', 'Fira Code', monospace;
        font-size: 0.8rem;
        line-height: 1.6;
        color: #404040;
    }

    /* Chat messages */
    .chat-observation {
        padding: 0.75rem 1rem;
        margin-bottom: 0.5rem;
        border-left: 3px solid #16a34a;
        background: #fafafa;
        font-size: 0.85rem;
        line-height: 1.5;
    }
    .chat-observation .meta {
        font-size: 0.75rem;
        color: #888;
        margin-bottom: 0.25rem;
    }
</style>
""", unsafe_allow_html=True)


# ---------------------------------------------------------------------------
# Helpers — SQLite reads (read-only, WAL-safe)
# ---------------------------------------------------------------------------

def get_db() -> sqlite3.Connection | None:
    """Open a read-only connection to the Periscope database."""
    if not os.path.exists(DB_PATH):
        return None
    conn = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def load_runs(conn: sqlite3.Connection) -> list[dict]:
    try:
        rows = conn.execute(
            "SELECT id, status, goal, cap_micro_usd, spent_micro_usd, created_at, completed_at, reason "
            "FROM runs ORDER BY created_at DESC LIMIT 50"
        ).fetchall()
        return [dict(r) for r in rows]
    except Exception:
        return []


def load_jobs(conn: sqlite3.Connection, run_id: str) -> list[dict]:
    try:
        rows = conn.execute(
            "SELECT id, purpose, kind, competitor, url, state, reason, created_at "
            "FROM jobs WHERE run_id = ? ORDER BY created_at",
            (run_id,),
        ).fetchall()
        return [dict(r) for r in rows]
    except Exception:
        return []


def load_events(conn: sqlite3.Connection, run_id: str, limit: int = 100) -> list[dict]:
    try:
        rows = conn.execute(
            "SELECT event_id, run_id, job_id, type, created_at, payload "
            "FROM events WHERE run_id = ? ORDER BY event_id DESC LIMIT ?",
            (run_id, limit),
        ).fetchall()
        return [dict(r) for r in rows]
    except Exception:
        return []


def load_observations(conn: sqlite3.Connection, run_id: str, competitor: str | None = None) -> list[dict]:
    try:
        query = "SELECT * FROM observations WHERE run_id = ?"
        params: list = [run_id]
        if competitor:
            query += " AND competitor = ?"
            params.append(competitor)
        query += " ORDER BY captured_at DESC LIMIT 200"
        rows = conn.execute(query, params).fetchall()
        return [dict(r) for r in rows]
    except Exception:
        return []


def count_observations(conn: sqlite3.Connection, run_id: str) -> int:
    try:
        row = conn.execute("SELECT COUNT(*) AS n FROM observations WHERE run_id = ?", (run_id,)).fetchone()
        return row["n"] if row else 0
    except Exception:
        return 0


def get_competitors_from_db(conn: sqlite3.Connection) -> list[str]:
    try:
        rows = conn.execute("SELECT DISTINCT competitor FROM observations ORDER BY competitor").fetchall()
        return [r["competitor"] for r in rows]
    except Exception:
        return []


# ---------------------------------------------------------------------------
# Competitor list persistence (JSON file, separate from SQLite)
# ---------------------------------------------------------------------------

def load_competitors() -> list[dict]:
    """Load competitor list. Each entry: { name, url, pages }."""
    if os.path.exists(COMPETITORS_FILE):
        with open(COMPETITORS_FILE) as f:
            return json.load(f)
    return [
        {"name": "example", "url": "https://example.com", "pages": ["/"]},
    ]


def save_competitors(competitors: list[dict]) -> None:
    os.makedirs(os.path.dirname(COMPETITORS_FILE), exist_ok=True)
    with open(COMPETITORS_FILE, "w") as f:
        json.dump(competitors, f, indent=2)


# ---------------------------------------------------------------------------
# Session state init
# ---------------------------------------------------------------------------

if "authenticated" not in st.session_state:
    st.session_state.authenticated = False
if "editing" not in st.session_state:
    st.session_state.editing = False
if "running" not in st.session_state:
    st.session_state.running = False
if "active_run_id" not in st.session_state:
    st.session_state.active_run_id = None
if "chat_messages" not in st.session_state:
    st.session_state.chat_messages = []


# ---------------------------------------------------------------------------
# Header
# ---------------------------------------------------------------------------

st.markdown(
    '<h1 style="color: #16a34a; font-weight: 800; font-size: 2.5rem; '
    'margin-bottom: 0.25rem;">Periscope</h1>',
    unsafe_allow_html=True,
)
st.markdown(
    '<p style="color: #6b7280; font-size: 0.9rem; margin-top: 0;">'
    "Competitive intelligence — read what websites hide.</p>",
    unsafe_allow_html=True,
)

st.divider()

# ---------------------------------------------------------------------------
# Layout: left = controls + progress, right = competitor list
# ---------------------------------------------------------------------------

left_col, right_col = st.columns([3, 2], gap="large")

# ---- RIGHT COLUMN: Competitor list ----------------------------------------

with right_col:
    st.markdown("##### Competitors")

    competitors = load_competitors()

    # Edit / lock toggle
    col_edit, col_spacer = st.columns([1, 3])
    with col_edit:
        if not st.session_state.editing:
            if st.button("Edit", use_container_width=True):
                if DEVICE_PASSWORD:
                    st.session_state.editing = "pending_auth"
                    st.rerun()
                else:
                    st.session_state.editing = True
                    st.rerun()
        else:
            if st.button("Lock", use_container_width=True):
                st.session_state.editing = False
                st.session_state.authenticated = False
                st.rerun()

    # Password gate
    if st.session_state.editing == "pending_auth":
        pw = st.text_input("Password", type="password", key="pw_input")
        if st.button("Unlock"):
            if pw == DEVICE_PASSWORD:
                st.session_state.authenticated = True
                st.session_state.editing = True
                st.rerun()
            else:
                st.error("Incorrect password.")

    # Display / edit competitor list
    if st.session_state.editing is True:
        st.caption("Add, edit, or remove competitors. Click **Lock** when done.")

        updated = []
        for i, comp in enumerate(competitors):
            with st.container():
                c1, c2, c3 = st.columns([2, 3, 1])
                with c1:
                    name = st.text_input("Name", value=comp["name"], key=f"name_{i}", label_visibility="collapsed")
                with c2:
                    url = st.text_input("URL", value=comp["url"], key=f"url_{i}", label_visibility="collapsed")
                with c3:
                    remove = st.button("Remove", key=f"rm_{i}")
                if not remove:
                    pages_str = st.text_input(
                        "Pages (comma-separated)",
                        value=",".join(comp.get("pages", ["/"])),
                        key=f"pages_{i}",
                        label_visibility="collapsed",
                    )
                    updated.append({
                        "name": name,
                        "url": url,
                        "pages": [p.strip() for p in pages_str.split(",") if p.strip()],
                    })

        if st.button("+ Add competitor"):
            competitors.append({"name": "", "url": "https://", "pages": ["/"]})
            save_competitors(competitors)
            st.rerun()

        # Auto-save on any change
        if updated != competitors:
            save_competitors(updated)
    else:
        # Read-only display
        if not competitors:
            st.info("No competitors configured yet.")
        for comp in competitors:
            pages_display = ", ".join(comp.get("pages", ["/"]))
            st.markdown(
                f'<div class="competitor-item">'
                f'<strong>{comp["name"]}</strong> &mdash; '
                f'<span style="color:#6b7280">{comp["url"]}</span>'
                f'<br><span style="font-size:0.75rem;color:#999">pages: {pages_display}</span>'
                f"</div>",
                unsafe_allow_html=True,
            )


# ---- LEFT COLUMN: Run controls + progress + chat -------------------------

with left_col:

    # --- Run button ---
    run_disabled = not competitors or all(not c.get("url") for c in competitors)

    col_run, col_opts = st.columns([1, 3])
    with col_run:
        run_clicked = st.button(
            "Run",
            type="primary",
            disabled=run_disabled,
            use_container_width=True,
        )
    with col_opts:
        countries_input = st.text_input(
            "Countries",
            value="CA,US,DE",
            help="Comma-separated ISO country codes for border testing",
            label_visibility="collapsed",
            placeholder="Countries (e.g. CA,US,DE)",
        )
        cap_usd = st.number_input("Budget cap ($)", min_value=1, max_value=100, value=12, label_visibility="collapsed")

    if run_clicked:
        st.session_state.running = True
        run_id = f"run-{int(time.time())}"
        st.session_state.active_run_id = run_id
        st.session_state.chat_messages = []

        # Launch backend process for each competitor
        processes = []
        for comp in competitors:
            if not comp.get("url"):
                continue
            pages = ",".join(comp.get("pages", ["/"]))
            cmd = [
                "npx", "tsx", "src/run.ts",
                "--competitor", comp["name"],
                "--url", comp["url"],
                "--pages", pages,
                "--jobs", "surface,benchmark,reveal",
                "--countries", countries_input.strip(),
                "--cap", str(cap_usd),
                "--run-id", run_id,
            ]
            env = {**os.environ, "PERISCOPE_DATA_DIR": DATA_DIR}
            try:
                proc = subprocess.Popen(
                    cmd,
                    cwd=str(Path(__file__).resolve().parent.parent),
                    env=env,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    text=True,
                )
                processes.append((comp["name"], proc))
            except FileNotFoundError:
                st.error(f"Could not start backend for {comp['name']}. Is Node.js installed?")

        if processes:
            st.info(f"Started run `{run_id}` for {len(processes)} competitor(s).")

    # --- Live progress ---
    conn = get_db()

    if conn and st.session_state.active_run_id:
        run_id = st.session_state.active_run_id
        run_info = None
        try:
            row = conn.execute("SELECT * FROM runs WHERE id = ?", (run_id,)).fetchone()
            if row:
                run_info = dict(row)
        except Exception:
            pass

        if run_info:
            st.markdown("##### Progress")

            # Status bar
            status = run_info.get("status", "unknown")
            spent = run_info.get("spent_micro_usd", 0) / 1_000_000
            cap = run_info.get("cap_micro_usd", 0) / 1_000_000
            obs_count = count_observations(conn, run_id)

            status_color = {
                "queued": "#6b7280",
                "running": "#2563eb",
                "completed": "#16a34a",
                "partial": "#d97706",
                "failed": "#dc2626",
                "cancelled": "#6b7280",
            }.get(status, "#6b7280")

            st.markdown(
                f'<span style="color:{status_color}; font-weight:600; font-size:0.9rem;">'
                f'{status.upper()}</span>'
                f' &nbsp; {obs_count} observations &nbsp; ${spent:.2f} / ${cap:.2f}',
                unsafe_allow_html=True,
            )

            # Jobs table
            jobs = load_jobs(conn, run_id)
            if jobs:
                for job in jobs:
                    state = job["state"]
                    indicator = {
                        "queued": "[ ]",
                        "starting": "[.]",
                        "running": "[~]",
                        "awaiting_human": "[!]",
                        "finalizing": "[~]",
                        "completed": "[x]",
                        "partial": "[/]",
                        "failed": "[-]",
                    }.get(state, "[ ]")

                    purpose = job.get("kind") or job.get("purpose", "")
                    comp = job.get("competitor", "")
                    reason = f' — {job["reason"]}' if job.get("reason") else ""

                    st.markdown(
                        f'<div class="progress-log">'
                        f"{indicator} <strong>{purpose}</strong> {comp}{reason}"
                        f"</div>",
                        unsafe_allow_html=True,
                    )

            # Event log (recent)
            with st.expander("Event log", expanded=False):
                events = load_events(conn, run_id, limit=50)
                for evt in events:
                    try:
                        payload = json.loads(evt["payload"])
                    except (json.JSONDecodeError, TypeError):
                        payload = {}
                    etype = evt["type"]
                    ts = evt["created_at"]
                    summary = ""
                    if etype == "job_state":
                        summary = f'{payload.get("state", "")} job {str(payload.get("jobId", ""))[:8]}'
                    elif etype == "observation":
                        text = str(payload.get("text", ""))[:80]
                        summary = f'{payload.get("kind", "")} — {text}'
                    elif etype == "spend":
                        summary = f'${payload.get("usd", 0):.3f}'
                    elif etype == "handoff":
                        summary = f'{payload.get("state", "")} {payload.get("wall", "")}'
                    else:
                        summary = etype

                    st.markdown(
                        f'<div class="progress-log">'
                        f'<span style="color:#999">{ts}</span> '
                        f'<span style="color:#2563eb">{etype}</span> {summary}'
                        f"</div>",
                        unsafe_allow_html=True,
                    )

            # Refresh button
            if status in ("queued", "running", "starting"):
                if st.button("Refresh"):
                    st.rerun()

            st.divider()

        # --- Chat interface (available once observations exist) ---
        if run_info and count_observations(conn, run_id) > 0:
            st.markdown("##### Query Research")

            # Competitor selector
            db_competitors = get_competitors_from_db(conn)
            selected_competitor = st.selectbox(
                "Competitor",
                options=["All"] + db_competitors,
                label_visibility="collapsed",
            )

            # Chat display
            for msg in st.session_state.chat_messages:
                with st.chat_message(msg["role"]):
                    st.markdown(msg["content"], unsafe_allow_html=True)

            # Chat input
            if query := st.chat_input("Ask about the research findings..."):
                st.session_state.chat_messages.append({"role": "user", "content": query})

                with st.chat_message("user"):
                    st.markdown(query)

                # Search observations via simple text matching (SQLite FTS fallback)
                # When Qdrant is available, this should use the Corpus.searchHydrated method
                comp_filter = None if selected_competitor == "All" else selected_competitor
                observations = load_observations(conn, run_id, comp_filter)

                # Simple keyword search as fallback
                query_lower = query.lower()
                relevant = [
                    obs for obs in observations
                    if query_lower in str(obs.get("text", "")).lower()
                       or query_lower in str(obs.get("competitor", "")).lower()
                       or query_lower in str(obs.get("url", "")).lower()
                ][:20]

                if not relevant:
                    # Show most recent observations if no keyword match
                    relevant = observations[:10]

                # Format response
                with st.chat_message("assistant"):
                    if relevant:
                        response_parts = [f"Found **{len(relevant)}** relevant observations:\n"]
                        for obs in relevant:
                            text = str(obs.get("text", ""))
                            if len(text) > 200:
                                text = text[:200] + "..."
                            layer = obs.get("layer", "")
                            kind = obs.get("kind", "")
                            url = obs.get("url", "")
                            comp = obs.get("competitor", "")

                            response_parts.append(
                                f'<div class="chat-observation">'
                                f'<div class="meta">{comp} | {layer} | {kind} | {url}</div>'
                                f"{text}</div>"
                            )
                        response = "\n".join(response_parts)
                    else:
                        response = "No observations found matching your query. Try different keywords or select a different competitor."

                    st.markdown(response, unsafe_allow_html=True)
                    st.session_state.chat_messages.append({"role": "assistant", "content": response})

        conn.close()

    elif not conn:
        st.caption("No database found yet. Run the backend to generate data.")

    # --- Previous runs (when no active run) ---
    if conn and not st.session_state.active_run_id:
        runs = load_runs(conn)
        if runs:
            st.markdown("##### Previous Runs")
            for run in runs[:10]:
                status = run.get("status", "unknown")
                spent = run.get("spent_micro_usd", 0) / 1_000_000
                rid = run["id"]

                status_color = {
                    "completed": "#16a34a",
                    "partial": "#d97706",
                    "failed": "#dc2626",
                }.get(status, "#6b7280")

                col_info, col_btn = st.columns([4, 1])
                with col_info:
                    st.markdown(
                        f'<span style="font-family:monospace;font-size:0.85rem;">'
                        f'{rid}</span> &nbsp; '
                        f'<span style="color:{status_color};font-weight:600">{status}</span>'
                        f' &nbsp; ${spent:.2f}',
                        unsafe_allow_html=True,
                    )
                with col_btn:
                    if st.button("View", key=f"view_{rid}"):
                        st.session_state.active_run_id = rid
                        st.rerun()
        conn.close()

    # Back button when viewing a run
    if st.session_state.active_run_id:
        st.markdown("---")
        if st.button("Back to all runs"):
            st.session_state.active_run_id = None
            st.session_state.chat_messages = []
            st.rerun()

# Demo runbook

Three beats, each one command. Run from the repo root in Git Bash with `MSYS_NO_PATHCONV=1` and `STEEL_API_KEY` set. Every command writes to `data/periscope.sqlite`; the scripts under `scripts/` read it back. Nothing here needs a Claude key; add `ANTHROPIC_API_KEY` to layer Stagehand on top.

## Frontend (API plus Streamlit)

Two terminals. The API launches runs, holds the Steel pool and answers every read; the Streamlit app only talks to the API.

```bash
MSYS_NO_PATHCONV=1 STEEL_API_KEY=... npm run api
```

```bash
pip install -r frontend/requirements.txt && streamlit run frontend/app.py
```

Open http://localhost:8501. Competitors on the right (ornn and spotify preloaded), Run on the left launches one run per competitor through `POST /runs`, the run view shows status, jobs, the red counter, the side by side, borders, prices, diff, matrix and events, and any wall appears under "Walls waiting for a human" with the live view link and a resume button. Without `STEEL_API_KEY` the API is read-only and the app browses earlier runs.

## Beat 1: side by side. Fetch versus Periscope

Ornn regulatory page. Fetch returns the page; Periscope clicks the Legal tab and finds the SLA, the terms and four docx files.

```bash
MSYS_NO_PATHCONV=1 npx tsx src/run.ts --competitor ornn --url https://ornn.com --pages /regulatory --jobs surface,benchmark,reveal --run-id demo-ornn-1
```

Watch for `[counter] ... missed by fetch: 6`. Then:

```bash
npx tsx scripts/inspect-run.ts demo-ornn-1
```

A bigger page for the same beat, about 90 seconds:

```bash
MSYS_NO_PATHCONV=1 npx tsx src/run.ts --competitor notion --url https://www.notion.com --pages /pricing --jobs surface,benchmark,reveal --run-id demo-notion-1
```

## Beat 2: borders. Same page, six countries and devices at once

Spotify premium from Canada, the United States and Germany, desktop and mobile, six Steel sessions in parallel, about 25 seconds.

```bash
MSYS_NO_PATHCONV=1 npx tsx src/run.ts --competitor spotify --url https://www.spotify.com --pages /premium/ --jobs surface,borders --countries CA,US,DE --run-id demo-spotify-1
```

```bash
npx tsx scripts/borders-grid.ts demo-spotify-1
```

Expect CA $13.99, US $12.99 with Hulu, DE 12,99 €, and `differs by country: true`.

## Beat 3: past the login

One-time setup per trial account (a human logs in once in the Steel live view; the password is typed into the terminal with echo off and stored in Steel, never in the repo):

```bash
npm run setup-account -- --competitor <name> --url <login url> --indicator <text visible only when signed in> --account trial1
```

```bash
npm run setup-credential -- --competitor <name> --origin <login origin> --username <email> --account trial1
```

Then the walker, which pauses on any wall, notifies, and resumes when a human clears it:

```bash
MSYS_NO_PATHCONV=1 npx tsx src/run.ts --competitor <name> --url <base url> --jobs walker --start <first page after login> --profile <profileId> --account <ref> --run-id demo-login-1
```

Rehearsed overnight without an account: a walker started on a login page classified the wall, tried Steel's solver, handed off with the live view, resumed on `POST .../resume`, and marked the job partial when the timer expired (`live-wall-github-1`, 223 s). For a rehearsal set `PERISCOPE_HUMAN_TIMEOUT_MS=150000` so the timer is 2.5 minutes instead of 10.

Resume after a wall from another terminal:

```bash
curl -X POST http://localhost:4747/jobs/<jobId>/resume
```

## What changed since last time

Run beat 1 or 2 again with a new run id, then:

```bash
npx tsx scripts/diff-runs.ts demo-spotify-1 demo-spotify-2
```

## Through the API instead of the CLI

```bash
STEEL_API_KEY=... npm run api
```

```bash
curl -s -X POST http://localhost:4747/runs -H "content-type: application/json" -H "idempotency-key: demo-1" -d '{"competitor":"ornn","url":"https://ornn.com","pages":["/regulatory"],"jobs":["surface","benchmark","reveal"],"runId":"demo-api-1"}'
```

```bash
curl -s -N http://localhost:4747/runs/demo-api-1/events
```

Then `GET /runs/demo-api-1/coverage`, `/borders`, `/prices`, `/diff?from=<earlier run>`; a wall appears at `GET /handoffs` and clears with `POST /jobs/<id>/resume`. Full contract: `docs/api.md`.

# Demo runbook

Three beats, each one command. Run from the repo root in Git Bash with `MSYS_NO_PATHCONV=1` and `STEEL_API_KEY` set. Every command writes to `data/periscope.sqlite`; the scripts under `scripts/` read it back. Nothing here needs a Claude key; add `ANTHROPIC_API_KEY` to layer Stagehand on top.

## The hook: Steel's own market

The judges work at Steel, so the demo competitor set is Steel's five closest rivals in browser infrastructure: Browserbase, Hyperbrowser, Anchor Browser, Browserless and Kernel, pricing pages first. The frontend preloads them. One command per competitor from the CLI:

```bash
for c in "browserbase https://www.browserbase.com" "hyperbrowser https://www.hyperbrowser.ai" "anchor https://anchorbrowser.io" "browserless https://www.browserless.io" "kernel https://www.onkernel.com"; do set -- $c; MSYS_NO_PATHCONV=1 npx tsx src/run.ts --competitor $1 --url $2 --pages /pricing --jobs surface,benchmark,reveal --run-id demo-$1; done
```

Borders on the one with regional pricing:

```bash
MSYS_NO_PATHCONV=1 npx tsx src/run.ts --competitor browserbase --url https://www.browserbase.com --pages /pricing --jobs surface,borders --countries CA,US,DE --run-id demo-browserbase-borders
```

Or press Run in the frontend, which does the same through the API.

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

## Live view for the judges

`streamlit run frontend/app.py` then open **http://localhost:8501/Live_view** (the page appears in the sidebar as "Live view"). Every Steel session the agents hold is embedded as a live player next to the event log. Launch from the page or from the API; browsers appear within seconds.

- **CAPTCHA beat:** jobs `walker`, start url `https://2captcha.com/demo/cloudflare-turnstile`. The wall is classified, Steel's solver runs first (the API must run with `STEEL_CAPTCHA=1`), the log prints `Steel CAPTCHA solver: solved`, the walk continues. If Steel gives up, the red wall card appears with the live view and a resume button.
- **Login beat without a saved account:** jobs `walker`, start url = the competitor's login page. The walker stops at the login wall, the card turns red, a teammate types the password inside the embedded live view, clicks "I cleared it, resume", and the walker crawls the signed-in space in the same session. Periscope never sees the password.
- **Six countries at once:** jobs `borders`, countries `CA,US,DE`: six browsers tile on the page, each captioned with its country and device.

## The Helix Ledger demo (the team's test SaaS, one button)

Helix Ledger lives in `../test_saas_startup` (Next.js, in-memory store, seeded user `test@test.com` / `admin123`). Steel's browsers run in the cloud, so the app needs a public url. Two windows:

```bash
cd ../test_saas_startup && pnpm dev
```

```bash
npx --yes cloudflared tunnel --url http://localhost:3000
```

Copy the `https://<words>.trycloudflare.com` url the tunnel prints (it changes every time the tunnel restarts) and start the frontend with it:

```bash
PERISCOPE_TARGET_URL=https://<words>.trycloudflare.com python -m streamlit run frontend/app.py --server.port 8502
```

On the main page, under "Live: the agents at work on Steel", press **Run the Helix Ledger demo**. Three runs start at once and every browser appears in the live section:

1. **Parse** (`helix-parse-*`): pricing, regulatory and security pages. The reveal flips the Monthly/Annual switch, opens Compare plans, selects every seat count, hovers Fair use limits, presses Show more, reads the ROI iframe and catches the page-load API call. Locally this finds all 18 planted lines plus the document and the API url; the counter reads about 23.
2. **Three countries** (`helix-borders-*`): six browsers, CA sees CA$ prices and the GST line, DE sees € prices and the German cookie banner (declined automatically), US sees $.
3. **Log in** (`helix-login-*`): the walker opens `/sign-in`, classifies the login wall, the card turns red. A teammate types the email and password in the embedded browser (the ALTCHA checkbox is part of the form), presses **I cleared it, resume**, and the walker crawls `/dashboard`, integrations, reports, settings and billing, recording the interior facts (seats used, bank connections, Beta and Coming soon badges, data region, card ending 4242) as interior observations. Billing and log-out links are observed, never pressed.

## Autonomous login (no human)

Store the test account once in Steel's credentials vault (the password is typed into a hidden terminal prompt, never into the repo):

```bash
STEEL_API_KEY=... npm run setup-credential -- --competitor helix-ledger --origin https://<words>.trycloudflare.com --username test@test.com --account trial1
```

The Helix demo button then launches the login run with `accountRef: trial1`. Steel injects the stored credentials into the sign-in form inside the browser, the walker ticks the ALTCHA box (it verifies itself in the browser), presses Sign in, and crawls the dashboard. The story card reads "Steel injected the stored credentials from its vault … signed in without a human". If the form is not filled or the wall stays, the walker falls back to the red human handoff card. The credential is bound to the exact origin, so store it again whenever the tunnel url changes.

# Overnight report, Sept 13 (Fahad's Claude session, segment C)

Branch: `fahad/overnight-c-completion`, 29 small commits on top of `main`. Open the PR at
https://github.com/MightyTMZ/periscope/compare/main...fahad/overnight-c-completion

Demo commands, in order, are in `docs/demo-runbook.md`. Everything below ran live against Steel; no Claude key was available, so the Stagehand layer is untested and every result here comes from the deterministic reveal.

## What is done

| Area | Status | Proof |
|---|---|---|
| pnpm 10 native builds (better-sqlite3, sharp, onnx) | Fixed in root package.json | Ayaan's tests pass locally |
| Steel adapter: profiles, credentials, sessions list, traces, files, CAPTCHA status and manual solve | Implemented against steel-sdk 0.18.0 types | C1, C3, C4, C8, C19, C22 live |
| Session pool: 10 slots, account lock, readiness gate, home-country guard, deadline checkpoint at minute 11, forced release at 14, crash journal and reconcile | Implemented | C2, C6, C7, C9, C10, C11 offline |
| Wall classifier, handoff lock, generation check, payment refusal, signed-in re-check, human timer, resume waiters | Implemented | C12 to C17, C21 offline |
| Steel-first CAPTCHA: Steel solver tried first, human only on failure, timeout, or unsupported family | Implemented | C21 offline, C22 live: Turnstile reached `solved` |
| Notifier: desktop toast, webhook, repeat every 2 minutes | Implemented | C18 |
| `setup-account` and `setup-credential` CLIs | Implemented | C8 live |
| StorageSink over Ayaan's Storage, creates run and job rows on first sight | Implemented | 3 integration tests |
| Coordinator handoff wiring: a wall keeps the session alive, Steel or a human clears it, the walk resumes | Implemented in Tom's coordinator, minimal | typecheck; waitForResolution test |
| End-to-end entry point `src/run.ts`, resume endpoint on port 4747 | Implemented | every live run below |
| **Deterministic reveal** (`src/reveal-deterministic.ts`): consent, tabs and accordions incl. Framer text tabs, selects, toggles, show more and infinite scroll, hover, modals, iframes, documents, hidden JSON calls; line-level diff against the surface baseline; URL-change guard; blocklist; counter event | Implemented, runs before Stagehand and alone when no model key | 12 fixture tests (B4, B7, B8, B9, B10, B11, B12, B13, B14, B20, B28, counter) |
| **Borders grid** (`src/intel/borders-grid.ts`): per vantage and per country, unique lines, price lines, country and device difference flags | Implemented | 4 unit tests, live Spotify below |
| **Run diff and coverage** (`src/intel/diff.ts`, `src/intel/coverage.ts`) | Implemented | 4 unit tests, `scripts/diff-runs.ts` |
| **Model-free walker** (`src/walker-deterministic.ts`): same-origin crawl behind the login, one interior observation per visible line per screen, blocked links (billing, log out, pay ...) observed but never visited, wall check after every navigation, checkpoint every 5 screens; the coordinator uses it when no model key is set | Implemented | fixture site test; live wall rehearsal below |
| **Fetch benchmark stores its sightings** as visible text (was raw HTML, never written) | Fixed in Tom's `src/benchmark.ts` | 2 tests; Ornn run shows benchmark 26 |
| **API, section 8.3** (`src/api`, branch `fahad/api`): account setups, runs with idempotency key and cancel, SSE events with `Last-Event-ID` reconnect, handoffs, takeover, resume, viewer, coverage, borders, prices, matrix, diff, findings, artifacts. Dependency-free `node:http`, read-only without a Steel key | Implemented | 16 tests (A14, A15, A16, A17), 17 fixture responses in `fixtures/api` (A18), live run launched through `POST /runs` |

Test totals across both branches: 71 offline passed, 7 live passed (C1, C3, C4, C5, C8, C19, C22), 1 todo (C20 with a real human; the loop itself is rehearsed live below).

## Live results that are the demo

| Beat | Run | Result | Time |
|---|---|---|---|
| Side by side, Ornn regulatory page | `live-reveal-ornn-3` | Legal tab reveals Service Level Agreement, Terms of Service and 4 docx files that fetch never returns. Counter: **6 missed by fetch** | 13 s |
| Side by side, Notion pricing | `live-reveal-notion-1` | 214 observations, 46 hidden, **44 missed by fetch** (toggle, compare, FAQ accordions) | about 90 s |
| Borders, Spotify premium, CA/US/DE, desktop and mobile | `live-borders-spotify-3` | CA **$13.99**, US **$12.99 with Hulu**, DE **12,99 €**; German cookie wall declined automatically; 6 sessions in parallel | 24 s |
| Run to run diff, Spotify run 1 vs run 3 | `scripts/diff-runs.ts` | 715 unchanged, 18 added, 34 removed (scroll-position noise, no price change in 30 minutes) | instant |
| **Model-free crawl of ornn.com** (no login, shows the walker on a real site) | `live-walk-ornn-2` | 11 screens, **328 interior lines** recorded, blocked links observed not visited; then the home page tripped the `kyc` rule (Ornn sells identity verification) and the job waited the full 10-minute timer before finishing `partial`. Rule tightened afterwards, see finding 11. Rerun `live-walk-ornn-3`: **17 screens, 471 interior lines, completed, no false wall** | 698 s, then 133 s |
| **Run through the API**, `POST /runs` then the event stream | `api-live-ornn-1` | 202 with run id, idempotent replay returned the same id, 12 events streamed to `event: end`, coverage counter 6 | 17 s |
| **Wall rehearsal (C20 without the human)**, walker started on github.com/login with a 150 s human timer | `live-wall-github-1` | wall classified, Steel solver tried first and timed out after 30 s, handoff `awaiting_human` with live view, `POST /jobs/:id/resume` returned ok and the walk resumed in the same session, wall again, timer expired, handoff `abandoned`, job `partial` with the reason. 13 events in SQLite | 223 s |

Print any of them again with `npx tsx scripts/inspect-run.ts <runId>`, `npx tsx scripts/borders-grid.ts <runId>`, `npx tsx scripts/diff-runs.ts <fromRunId> <toRunId>`.

## Findings the team must know

1. **Observation ids are now scoped to the run.** Tom's factory hashed competitor, url, vantage and text, so a second run of the same page recorded nothing (Storage rejects a repeated id as a duplicate) and a diff had nothing to compare. `src/utils/observation-factory.ts` now includes the run id in the hash. Within a run the id still deduplicates. Ayaan: the embedding outbox will re-embed identical text each run, which is CPU only.
2. **Steel profiles do not persist cookies.** Four variants tried. Layer 3 login relies on credential injection (C8, working) on every walker session. Ask the Steel mentors.
3. **Steel's CAPTCHA solver is real but not deterministic.** Turnstile every run; reCAPTCHA v2 sometimes; hCaptcha never detected. Attaches only after full page load. Status endpoint returns an array of page states.
4. **Proxies and the solver are unlocked** with the paid balance. CA, US, DE resolve correctly; DE really serves German and euro prices.
5. **Steel scrape on Framer sites:** use `markdown`, `readability` is empty. Tom's surface pass now requests both.
6. **Git Bash rewrites `--pages /x`.** Run with `MSYS_NO_PATHCONV=1`; `run.ts` refuses mangled paths.
7. **Stagehand 4.1.0 does not list `claude-opus-5`.** Bridge defaults to `anthropic/claude-opus-4-8`, override with `STAGEHAND_MODEL`.
8. **A full reveal per vantage is too slow for borders** (six sessions hit the 11-minute deadline). Borders runs the light strategy set (consent, toggles, selects, documents, hidden API) and records every vantage's baseline lines under the `borders` layer so the grid has rows. Full strategies remain for the single-vantage reveal job.
9. **Consent walls are multilingual.** The decline regex now covers German, French, Spanish, Italian and Dutch; without it DE showed only the cookie dialog.
11. **A wall must ask for something.** The kyc, payment, 2fa and email-code rules now require a visible input on the page; words alone (a KYC vendor's marketing copy) no longer pause a walk. Negative fixture `kyc-marketing.html` in C12.
12. **Two runs on one machine** used to crash the second on the resume port; it now warns and continues, `PERISCOPE_RESUME_PORT` picks another port.
10. **Ayaan's Storage.write is synchronous and needs run and job rows.** StorageSink handles both. His API should forward `POST /jobs/:id/resume` to `segment.resume`, replacing the minimal resume server, and can call `bordersGrid`, `diffRuns` and `coverage` from `src/intel` directly, they are pure functions over `getObservationsByRun`.

## Files I touched outside segment C, for the owners to review

- `src/coordinator.ts` (Tom): walker loop handles walls through `onWall` and `waitForResolution`; reveal, borders and walker run the deterministic pass and Stagehand only when `ANTHROPIC_API_KEY` is set.
- `src/benchmark.ts` (Tom): observations are written to the sink and built from visible text, not raw HTML.
- `src/borders.ts` (Tom): light strategies, baseline emitted as `borders` layer.
- `src/utils/observation-factory.ts` (Tom): run id in the observation hash, finding 1.
- `src/utils/stagehand-bridge.ts` (Tom): model name from env with an Opus 4.8 default.
- `src/surface.ts` (Tom): scrape formats, finding 5.
- `src/intel/**` (Ayaan's namespace): grid, diff, coverage as pure helpers; his to keep, move or replace.
- `package.json`, `tsconfig.json`, `vitest.config.ts` (shared): pnpm build approvals, knowledge path alias.

## What is left, in order

1. **C20 live handoff, together.** Walker on a page with a CAPTCHA Steel cannot solve (hCaptcha demo), notifier fires, solve in the live view, POST resume, walk continues. Everything exists; it needs a human on the live view.
2. **API is on branch `fahad/api`**, ready to merge: `npm run api`, contract in `docs/api.md`, fixtures in `fixtures/api/`. Ayaan owns it from here; the matrix route returns findings of kind `feature`, which his extraction should create. The frontend can start from the fixtures now.
3. **Stagehand layer with a Claude key.** The deterministic pass already produces the demo numbers; the model adds judgement on pages the strategies do not cover and lets the walker operate buttons and menus instead of only links. Set `ANTHROPIC_API_KEY` and rerun the Ornn command in the runbook.
4. **Trial accounts:** `setup-account` then `setup-credential` for each, then a walker run with `--profile` and `--account`.

## Spend

Steel: about 60 short sessions, a few CAPTCHA solves, about 20 proxy sessions. Under 3 dollars of the 10. Claude: none, no key available.

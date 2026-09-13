# Overnight report, Sept 13 (Fahad's Claude session, segment C)

Branch: `fahad/overnight-c-completion`, 8 small commits on top of `main`. Open the PR at
https://github.com/MightyTMZ/periscope/compare/main...fahad/overnight-c-completion

## What is done

| Area | Status | Proof |
|---|---|---|
| pnpm 10 native builds (better-sqlite3, sharp, onnx) | Fixed in root package.json | Ayaan's A1, A2, A5, artifacts tests pass locally (38 tests) |
| Steel adapter: profiles, credentials, sessions list, traces, files, CAPTCHA status and manual solve | Implemented against steel-sdk 0.18.0 types | C1, C3, C4, C8, C19, C22 live |
| Session pool: 10 slots, account lock, readiness gate, home-country guard, deadline checkpoint at minute 11, forced release at 14, crash journal and reconcile | Implemented | C2, C6, C7, C9, C10, C11 offline |
| Wall classifier, handoff lock, generation check, payment refusal, signed-in re-check, human timer, resume waiters | Implemented | C12 to C17, C21 offline |
| Steel-first CAPTCHA: Steel solver tried first, human only on failure, timeout, or unsupported family | Implemented | C21 offline, C22 live: Turnstile reached `solved` |
| Notifier: desktop toast, webhook, repeat every 2 minutes | Implemented | C18 |
| `setup-account` CLI (human login once, profile saved and waited to READY) and `setup-credential` CLI (password read with echo off, stored in Steel) | Implemented | C8 live |
| StorageSink: the shared EventSink contract over Ayaan's Storage, creates run and job rows on first sight | Implemented | 3 integration tests, in-memory SQLite |
| Coordinator handoff wiring: a wall keeps the session alive, Steel or a human clears it, the walk resumes | Implemented in Tom's coordinator, minimal and commented | typecheck; waitForResolution test |
| End-to-end entry point `src/run.ts` and a minimal resume endpoint on port 4747 | Implemented | Live smoke: surface + benchmark on ornn.com, 2 jobs, 59 observations, 66 events in SQLite, 6 seconds |

Test totals on the branch: 31 offline passed, 7 live passed (C1, C3, C4, C5, C8, C19, C22), 1 todo (C20, needs the team).

## Findings the team must know

1. **Steel profiles do not persist cookies.** Four variants tried, including Steel's own documented minimal pattern and a 40-second settle before release. The profile reaches READY, and localStorage survived in one run of three, but cookies never did. Most SaaS logins live in cookies. Consequence: Layer 3 login relies on **credential injection** (C8, working) on every walker session, with the profile as a bonus. Use `npm run setup-credential` for each trial account. Ask the Steel mentors whether cookie persistence is expected to work.
2. **Steel's CAPTCHA solver is real but not deterministic.** Turnstile solved every run; reCAPTCHA v2 solved once and was missed once; hCaptcha is never detected. The solver attaches only after a full page load, so navigate with `waitUntil: "load"` before expecting it. The status endpoint returns an array of page states, not the object in the docs.
3. **Proxies and the solver are unlocked** now that the account has a paid balance. Countries CA, US, DE resolve correctly.
4. **Steel's scrape endpoint on Framer sites:** `readability` returns 15 characters on ornn.com while `markdown` returns 2.6k. Tom's surface pass now requests `["markdown", "html"]` and uses markdown for blocks.
5. **Git Bash on Windows rewrites `--pages /x` into `C:/Program Files/Git/x`.** Cost an hour. `run.ts` now refuses such paths with a message; run with `MSYS_NO_PATHCONV=1`.
6. **Stagehand 4.1.0 does not list `claude-opus-5`.** The bridge defaults to `anthropic/claude-opus-4-8`, the newest Opus it knows, with `STAGEHAND_MODEL` as the override.
7. **Ayaan's Storage.write is synchronous and needs run and job rows.** The StorageSink handles both so the coordinator needs no registration step. His API should forward `POST /jobs/:id/resume` to `segment.resume`, replacing the minimal resume server.

## Files I touched outside segment C, for the owners to review

- `src/coordinator.ts` (Tom): walker loop handles walls through `onWall` and `waitForResolution`; no other logic changed.
- `src/utils/stagehand-bridge.ts` (Tom): model name from env with an Opus 4.8 default.
- `src/surface.ts` (Tom): scrape formats, see finding 4.
- `package.json`, `tsconfig.json`, `vitest.config.ts` (shared): pnpm build approvals, knowledge path alias.

## What is left, in order

1. **C20 live handoff, together.** Run a walker on a page with a real CAPTCHA that Steel cannot solve (hCaptcha demo), watch the notifier fire, solve it in the live view, POST resume, watch the walk continue. Everything for it exists; it needs a human on the live view.
2. **Ayaan's API** replaces the minimal resume server and serves coverage, borders, matrix, diff.
3. **Reveal and walker live** need `ANTHROPIC_API_KEY`, which I did not have overnight. First run: `MSYS_NO_PATHCONV=1 npx tsx src/run.ts --competitor ornn --url https://ornn.com --pages /regulatory --jobs surface,benchmark,reveal --cap 3` and confirm the counter reports 4 missed documents on the regulatory page (I1 and I2).
4. Five trial accounts: `setup-account` then `setup-credential` for each, Friday-night checks 3 and 4 from the architecture doc.

## Spend

Steel: roughly 40 short sessions, a few CAPTCHA solves, three proxy sessions. Well under 2 dollars of the 10. Claude: none, no key available.

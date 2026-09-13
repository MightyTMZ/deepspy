# Contributing

## Branches and commits

- Branch: `<name>/<feature>` in lowercase, for example `fahad/session-pool`, `ayan/coverage-counter`.
- Commit message: `<name>: <feature or change>`, for example `fahad: add session pool with 10-slot lease`.
- One owner per module. Only touch another owner's module in a pull request they review.

## Merging

- `main` is protected. A pull request merges when the owner's segment tests pass and the reviewer, the owner whose contract you consume, approves.
- Paste the test output into the pull request description.
- `packages/contracts` changes need all three owners on the pull request.
- Merge order for the first integration: contracts, then Fahad (Steel and human in the loop), then Person B (parser), then Ayan (intelligence).

## Owners

| Owner | Layers | Code |
|---|---|---|
| Ayan | knowledge, intelligence, API | `apps/api/src/intel/**` |
| Person B | agent, policy | `apps/api/src/parser/**` |
| Fahad | browser, human in the loop | `apps/api/src/steel/**` |

Full spec with test ids: `docs/periscope-final-architecture.md`.

## Running

```bash
npx pnpm@10 install
cp env.template .env          # fill STEEL_API_KEY; ANTHROPIC_API_KEY is optional
npx pnpm@10 typecheck
npx pnpm@10 vitest run        # offline: fixtures, pool, handoff, intel, storage sink
npm run test:steel:live       # live against Steel, needs STEEL_API_KEY
npm run api                   # HTTP API on :4747, read-only without STEEL_API_KEY; contract in docs/api.md
```

## Running the pipeline end to end

Without `ANTHROPIC_API_KEY` every job runs the deterministic Playwright layer (reveal strategies, link walker). With it, Stagehand runs on top. Commands for the three demo beats are in `docs/demo-runbook.md`.

```bash
MSYS_NO_PATHCONV=1 STEEL_API_KEY=... npx tsx src/run.ts --competitor ornn --url https://ornn.com --pages /regulatory --jobs surface,benchmark,reveal --countries CA,US,DE --run-id demo-1
npx tsx scripts/inspect-run.ts demo-1
npx tsx scripts/borders-grid.ts demo-1
npx tsx scripts/diff-runs.ts demo-1 demo-2
```

Environment knobs: `STEEL_CAPTCHA=1` turns on Steel's solver, `PERISCOPE_HUMAN_TIMEOUT_MS` shortens the human timer for rehearsals, `PERISCOPE_WEBHOOK_URL` mirrors handoff notifications, `STAGEHAND_MODEL` overrides the model name.

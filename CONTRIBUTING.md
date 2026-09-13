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
npm install
cp .env.example .env
npm run test:steel          # fixture tests, no keys needed
npm run test:live           # live tests against Steel, needs STEEL_API_KEY
npm run setup-account -- --competitor <name> --url <login url>
```

## Running the pipeline end to end

```bash
MSYS_NO_PATHCONV=1 STEEL_API_KEY=... ANTHROPIC_API_KEY=... npx tsx src/run.ts --competitor ornn --url https://ornn.com --pages /regulatory,/product --jobs surface,benchmark,reveal --countries CA,US,DE --cap 12
```

`MSYS_NO_PATHCONV=1` matters on Windows Git Bash: without it, `--pages /regulatory` reaches Node as `C:/Program Files/Git/regulatory`.
A handoff prints a live-view URL; resolve it there, then `curl -X POST http://localhost:4747/jobs/<jobId>/resume`.

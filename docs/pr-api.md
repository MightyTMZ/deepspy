# PR: fahad/api → main

Section 8.3, the API, so the frontend and the demo have an HTTP surface. Reviewers: Ayaan (owner of layers 5 to 7; this is his namespace), Tom (`src/run.ts` now goes through the shared launcher).

## What it adds

- `src/api/server.ts`: every route in section 8.3 on `node:http`, no new dependencies. Read routes work from SQLite alone; routes that need a browser answer 503 with the documented shape when no Steel key is set.
- `src/integration/launch-run.ts`: one in-process launcher used by the CLI and the API, events routed per run so concurrent runs share the one Steel pool.
- `src/intel/prices.ts`: pricing rows with decimal amount, currency, period, each carrying its observation id.
- `docs/api.md` contract, `fixtures/api/*.json` example responses for all 17 routes (`npm run api:fixtures`).

## Proof

- 16 API tests: A14 shapes on fixtures, A15 SSE reconnect with `Last-Event-ID`, A16 spend in dollars, A17 evidence drawer, idempotent `POST /runs`, cancel, handoff takeover and resume forwarding.
- Live: `POST /runs` launched `api-live-ornn-1` on Steel, replay with the same idempotency key returned the same run id, 12 events streamed to `event: end` in 17 s, `/coverage` counter 6.
- The CLI after the refactor produced the same result (`cli-after-refactor-1`, 14 s).

```
Test Files  15 passed | 1 skipped (16)
     Tests  71 passed | 7 skipped | 1 todo (79)
```

## For Ayaan

- `/matrix` serves findings of kind `feature`; your extraction writes them with `createFinding` and the evidence ids resolve through `/findings/:id`.
- `/prices` and `/borders` are rule-based today; replace or refine with the model behind the same shapes.
- Account setup routes drive the same flow as the CLI; a person still logs in by hand in the live view.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

# PR: fahad/overnight-c-completion → main

Paste as the pull request description. Reviewers: Tom (coordinator, borders, benchmark, observation factory), Ayaan (`src/intel`, StorageSink, run-scoped ids).

## Summary

Segment C is complete and every demo beat runs live on Steel without a Claude key.

- Steel adapter, session pool, wall classifier, Steel-first CAPTCHA policy, handoff controller, notifier, credential and profile CLIs, StorageSink, end-to-end `src/run.ts`, resume endpoint.
- Deterministic reveal layer (consent, tabs, selects, toggles, show more, scroll, hover, modals, iframes, documents, hidden JSON) with a line-level diff and the "missed by fetch" counter.
- Model-free walker for the signed-in web space, with wall handoff and resume in the same session.
- Borders grid, run diff and coverage as pure functions in `src/intel` for Ayaan's API.
- Fixes in shared code: benchmark writes its sightings, observation ids scoped to run and source, Stagehand model from env, scrape formats for Framer sites.

## Live proof

| Beat | Run id | Result |
|---|---|---|
| Side by side, ornn.com/regulatory | `demo-ornn-2` | counter 6 missed by fetch, 5 documents behind the Legal tab, 15 s |
| Side by side, notion.com/pricing | `live-reveal-notion-1` | 44 missed by fetch |
| Borders, spotify.com/premium, CA/US/DE × desktop/mobile | `live-borders-spotify-3` | CA $13.99, US $12.99 + Hulu, DE 12,99 €, 24 s |
| Wall handoff and resume, github.com/login | `live-wall-github-1` | classify → Steel solver → awaiting_human → resume ok → abandoned on timer → partial, 223 s |
| Model-free crawl, ornn.com | `live-walk-ornn-2` | 11 screens, 328 interior lines |

## Tests

```
Test Files  14 passed | 1 skipped (15)
     Tests  55 passed | 7 skipped | 1 todo (63)
```

Live tests (`npm run test:steel:live`): C1, C3, C4, C5, C8, C19, C22 pass. C20 needs a human on the live view; the loop is rehearsed in `live-wall-github-1`.

## Notes for owners

- Tom: `src/coordinator.ts` runs the deterministic layer first and Stagehand only with `ANTHROPIC_API_KEY`; `src/benchmark.ts` now writes observations; `src/utils/observation-factory.ts` hashes run id and source.
- Ayaan: ids are per run so diffs work; `src/intel/*` are pure helpers over `getObservationsByRun`; please forward `POST /jobs/:id/resume` to `segment.resume`.
- Full report: `docs/overnight-report-2026-09-13.md`. Demo commands: `docs/demo-runbook.md`.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

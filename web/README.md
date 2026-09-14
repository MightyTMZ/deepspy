# Periscope · Depth Map

A static Next.js App Router / TypeScript console with Sora and Roboto Mono from Google Fonts. The centre of the page is the live section, wired to the Periscope API the same way the Streamlit page was: every Steel browser the agents hold is embedded as a live player, a Steel usage trace names every feature as it is used (proxies by country, device emulation, saved logins, walls), walls get a card with an "I cleared it, resume" button, one story card explains each run, and the intelligence tabs (coverage, countries, prices, feature matrix) fill from the same run. Below it sit the evidence corpus and the controlled benchmark. Palette and layout tokens live in `app/globals.css`; the API client is `lib/api.ts` and the plain-language derivations are `lib/story.ts`.

## Run locally

```bash
cd web && npm ci && npm run dev
```

Open http://localhost:3000. Node.js 20.9 or newer is required. Start the API from the repository root with `STEEL_API_KEY=... npm run api` (port 4747); the console connects to that address by default. Without the API the page shows the static schematic instead of the live section's browsers.

Environment (all optional, read at build time):

| Variable | Default | Meaning |
| --- | --- | --- |
| `NEXT_PUBLIC_PERISCOPE_API_URL` | `http://localhost:4747` | Where the Periscope API answers |
| `NEXT_PUBLIC_PERISCOPE_TARGET_URL` | `https://testsaasstartup.vercel.app` | Helix Ledger, the target of the one-button demo |
| `NEXT_PUBLIC_PERISCOPE_TARGET_EMAIL` | `test@test.com` | The account shown next to the login beat (the password lives only in Steel's vault) |

The Helix button posts three runs to `POST /runs`: parse (surface, benchmark, reveal on pricing, regulatory and security), three countries (borders from CA, US and DE, six browsers) and log in (walker with `accountRef: "trial1"`, so Steel injects the vaulted credential). Store that credential once with `npm run setup-credential -- --competitor helix-ledger --origin https://testsaasstartup.vercel.app --username test@test.com --account trial1` from the repository root.

## Deploy on Vercel

The site is a static export (`output: "export"`), so it needs no server. The `vercel.json` at the repository root installs and builds this folder and serves `out/`; import the repository at vercel.com/new and press Deploy. A hosted page cannot call `http://localhost`, so give it a public address for the API: run `npx cloudflared tunnel --url http://localhost:4747` and paste the printed https address into the **Periscope API** field on the page (remembered per browser; `?api=https://...` in the URL also works), or set `NEXT_PUBLIC_PERISCOPE_API_URL` in the Vercel project for a permanent one. Alternatively set the project's Root Directory to `web` and let Vercel's Next.js preset build it.

## Production checks

```cmd
npm run build
npm run typecheck
```

The production build produces `out/` using Next.js static export: https://nextjs.org/docs/app/guides/static-exports. There are no runtime server routes. Do not use `next start` for this export.

## Deploy on Vercel

From this project directory:

```cmd
npx vercel login
npx vercel
npx vercel --prod
```

Choose this directory (`./`) when prompted. Allow Vercel to detect Next.js and use `npm run build`. The first deployment is a preview; the final command deploys to production and prints the public URL. Alternatively import a GitHub repository in Vercel with `periscope-site` as the Root Directory if this folder is at its root. This standalone folder is currently separate from the existing `periscope-review` checkout; push it to the repository you intend to deploy before using Git import.

## Files

```text
app/
  globals.css            Design tokens, layouts, focus and responsive styles
  icon.svg               Periscope mark
  layout.tsx             Fonts and metadata
  page.tsx               Header, depth navigation, six sections, footer
components/
  sections.tsx           Hero, problem, architecture, benchmark
  explorer.tsx           Browser observations, trace, and recovered views
public/
  snapshot.json          Source of benchmark and recovered facts
scripts/
  source.mjs             Produce a readable complete source listing
.gitignore
next-env.d.ts
next.config.ts
package.json
package-lock.json
tsconfig.json
README.md
```

`npm run source` creates `SOURCE.md` with the file tree and every authored file's complete contents; the generated dependency lockfile is provided separately.

The first section presents labelled REVEAL, BORDERS, and WALKER browser instances. The controls are interactive and the center stage shows a reconstructed target state or the repository's original live-view screenshot. It deliberately labels missing session IDs, timings, prices, and proxy observations as unavailable. A real Steel player can be connected by replacing a job's `playerUrl` in `public/console.json` with a trusted Steel embed URL; URLs are allow-listed to `steel.dev` and the iframe is not faked.

The second section is an SVG evidence graph connecting target pages, actions, facts, and context. The graph is a compact visual model of the SQLite/Qdrant knowledge layer, clearly labelled illustrative rather than an exported vector index. The third section loads the repository's published `benchmarks/` report, rubric, and manual ChatGPT result into a chart and expandable group table. It distinguishes Periscope's 63 facts in collected material from Opus's 58 reported facts, and keeps ChatGPT's separately hand-scored 38 visible.

## Evidence and honest missing states

The JSON contains only the supplied controlled benchmark and three reported examples. It is not an independently verified benchmark. The source repository's API fixtures are generated from seeded test data and are intentionally excluded.

Browser observations are selectable; the chosen route and reconstructed trace update together. Data-view buttons switch between country pricing, page coverage, and the feature matrix. Evidence links select their corresponding observation. JSON download works without a server API. Method details are keyboard operable.

Original event timestamps and session metadata were not supplied. Timestamp fields remain null and the UI explicitly renders unavailable values instead of inventing a run. The trace describes the reported observation path, not recorded machine events. Country is also unknown: CAD identifies currency, not proof of a Canadian proxy. Full per-page counts and additional regional prices remain unavailable. Authenticated access is reported for the seat example; a recorded human handoff is not claimed.

To publish an actual timestamped session trace, replace the reconstructed paths with a sanitized real event export, preserving timestamps and session context. Do not put login credentials, tokens, or personal account data into public JSON. The live-run section can only become a genuine recorded-run showcase once those artifacts exist.

## Visual direction

Midnight `#0C1522`: canvas. Deep navy `#142338`: depth bands. Frost `#E8F0F7`: primary type and primary action. Mist `#A3B4C7`: secondary type. Steel blue `#365775`: structure. Cyan `#76DCE8`: selected evidence paths and highlighted benchmark result. Neutral dividers and spacing define the page; no entrance animations or gradients. Mobile uses a narrow margin scale, stacked observations, and locally scrollable data tables. Focus rings, reduced-motion support, semantic landmarks, button pressed states, and accessible chart labels are included.

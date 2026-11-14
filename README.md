# Recall

Your AI conversations remember what you discussed. Recall makes sure you do something about it.

Recall analyses a Claude data export, finds unfinished projects and commitments, backs each one with a quote from the source conversation, and helps you resume the work. It runs entirely on free tiers: Next.js on Vercel Hobby, Firebase Authentication and Cloud Firestore on the Spark plan, and the Gemini Developer API free tier.

**Status:** Milestone 2 of 10 (project foundation). Nothing user-facing works yet beyond the landing page.

## Requirements

- Node.js 22 or newer
- A Firebase project on the Spark plan with Email/Password sign-in enabled (from Milestone 3)
- A Gemini API key from Google AI Studio (from Milestone 6)

## Setup

```bash
npm install
cp .env.example .env.local   # then fill in the values
npm run dev
```

Open http://localhost:3000.

## Scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` | Development server |
| `npm run build` | Production build |
| `npm run lint` | ESLint |
| `npm run typecheck` | TypeScript, no emit |
| `npm test` | Vitest, single run |
| `npm run test:watch` | Vitest in watch mode |

## Environment variables

Documented in [`.env.example`](.env.example). `NEXT_PUBLIC_FIREBASE_*` values are the public Firebase web config. Everything else is a server-only secret and must never be prefixed with `NEXT_PUBLIC_`. On Vercel, add them under Project Settings, Environment Variables.

## Inspecting your Claude export

Before the importer is built, the parser needs the real structure of your export. This script prints key names, types, counts and lengths only, never message text:

```bash
node scripts/inspect-claude-export.mjs /path/to/unzipped-export > export-structure.txt
```

Read the output before sharing it.

## Project layout

```text
app/            routes and layouts (App Router)
components/ui/  shadcn/ui primitives
lib/env/        validated environment access (client and server)
lib/firebase/   web SDK and Admin SDK initialisation
lib/utils.ts    shared helpers
scripts/        local tooling
tests/unit/     Vitest unit tests
docs/           architecture and development notes
```

The full target layout is in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), section 9.

## Documentation

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md): approved architecture, schema, security strategy and plan
- [`docs/DEVELOPMENT_NOTES.md`](docs/DEVELOPMENT_NOTES.md): decisions and results per milestone
- [`AGENTS.md`](AGENTS.md): this Next.js version differs from older ones; read the bundled docs before changing framework code

# Recall

Your AI conversations remember what you discussed. Recall makes sure you do something about it.

Recall analyses a Claude data export, finds unfinished projects and commitments, backs each one with a quote from the source conversation, and helps you resume the work. It runs entirely on free tiers: Next.js on Vercel Hobby, Firebase Authentication and Cloud Firestore on the Spark plan, and the Gemini Developer API free tier.

**Status:** Milestone 8 of 10 (execution dashboard). You can import a Claude export, have it analysed, review the findings in an Inbox, then work from them: an Execution Inbox, a Forgotten Work list, a weekly report and a daily overview. The AI pipeline has been tested with a stand-in model only; it has not yet run against Gemini.

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
| `npm run test:rules` | Security rules and import writer tests on the Firestore emulator (needs Java 21) |
| `npm run test:e2e` | Browser tests against a production build and the emulators (run `npm run build` first, in emulator mode) |
| `npm run emulators` | Auth and Firestore emulators for local development |

## Local development with emulators

No real Firebase project is needed to run the app locally.

1. In `.env.local` set `NEXT_PUBLIC_USE_FIREBASE_EMULATORS=true`, `NEXT_PUBLIC_FIREBASE_PROJECT_ID=demo-recall`, placeholder values for the other `NEXT_PUBLIC_FIREBASE_*` variables, and `FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099` and `FIRESTORE_EMULATOR_HOST=127.0.0.1:8080`.
2. Run `npm run emulators` in one terminal and `npm run dev` in another.
3. Verification and reset links appear in the emulator terminal output instead of being emailed.

Never set the emulator variables on Vercel.

## Deploying security rules

Rules and indexes live in `firestore.rules` and `firestore.indexes.json`. Deploy them from your machine after `npx firebase login`:

```bash
npx firebase deploy --only firestore:rules,firestore:indexes --project <your-project-id>
```

This replaces the rules of that project's default Firestore database. Use a Firebase project dedicated to Recall.

## Environment variables

Documented in [`.env.example`](.env.example). `NEXT_PUBLIC_FIREBASE_*` values are the public Firebase web config. Everything else is a server-only secret and must never be prefixed with `NEXT_PUBLIC_`. On Vercel, add them under Project Settings, Environment Variables.

## Setting the service account

The server needs a Firebase service account to verify sign-ins. Download a key from Firebase console, Project settings, Service accounts, Generate new private key, then:

```bash
node scripts/set-service-account.mjs path/to/downloaded-key.json
```

This writes `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL` and `FIREBASE_PRIVATE_KEY` into `.env.local` in the right format without printing the key.

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
components/auth/ and components/app/  auth state, forms, guarded app shell
lib/domain/     source-independent types, schemas and hashing
lib/sources/    one adapter per AI platform (Claude today)
lib/import/     browser-side archive validation, streaming parser, worker client
workers/        the import Web Worker
lib/ai/         provider interface, Gemini and fake providers, prompts, redaction, verification
lib/server/analysis/  resumable analysis jobs, persistence of findings, usage counter
components/analysis/  consent, analysis panel, exclusions
lib/auth/       client auth helpers (errors, authenticated fetch, profile)
lib/env/        validated environment access (client and server)
lib/firebase/   web SDK and Admin SDK initialisation
lib/server/     server-only guard (withAuth) and path builder
firestore.rules, firestore.indexes.json, firebase.json
tests/rules/    security rules tests (emulator)
lib/utils.ts    shared helpers
scripts/        local tooling
tests/unit/     Vitest unit tests
tests/fixtures/ synthetic Claude export generator
docs/           architecture and development notes
```

The full target layout is in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), section 9.

## Documentation

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md): approved architecture, schema, security strategy and plan
- [`docs/DEVELOPMENT_NOTES.md`](docs/DEVELOPMENT_NOTES.md): decisions and results per milestone
- [`AGENTS.md`](AGENTS.md): this Next.js version differs from older ones; read the bundled docs before changing framework code

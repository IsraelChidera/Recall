# Development notes

Decisions and verified results per milestone. Newest milestone first.

## Milestone 4: Claude import (14 November 2026)

**Objective.** Read a Claude export in the browser: validate the archives, stream-parse them, normalise conversations, de-duplicate, and show progress and a preview. Nothing is written to Firestore yet; that is Milestone 5.

**What the real export looks like**

Recorded in `ARCHITECTURE.md` under amendments. The structure was obtained with `scripts/inspect-claude-export.mjs`, which prints key names, types, counts and lengths only. The real archive was then run through the pipeline in Node, printing counts only: 62 conversations parsed, 0 skipped, 0 issues, the three non-conversation ZIPs ignored.

**Decisions**

- **Source adapters.** `lib/sources/types.ts` defines the contract; `lib/sources/claude` is the only implementation. The pipeline in `lib/import/parse-export.ts` knows nothing about Claude.
- **Streaming.** JSZip decompresses `conversations.json` as chunks. `JsonArrayElementSplitter` cuts the byte stream into top-level array elements, so one conversation is buffered at a time. The reader pauses until each conversation has been handled.
- **Worker and backpressure.** `workers/import.worker.ts` posts batches of up to 20 conversations (or 1.5 million characters) and waits for an acknowledgement. Milestone 5 plugs the Firestore writer into `runImport`'s `onBatch`.
- **Active thread.** Unknown senders and malformed messages are dropped first; then the path from the most recent leaf to the root is kept. If no parent links resolve, export order is used.
- **Text kept.** `text` content blocks only. Thinking, tool calls and tool results are dropped. Assistant replies are cut to 4,000 characters; human messages are kept up to 50,000.
- **Attachments are counted, not imported.** Pasted documents arrive as attachments with extracted text. A commitment stated only inside a pasted document will not be seen. To revisit if extraction misses things.
- **Content hash** covers the source `updated_at`, message count, last message id and total text length. **Import fingerprint** is a hash of the sorted conversation ids and hashes, so it is independent of file names and order.
- **Duplicates across files.** An identical copy is dropped. A differing copy is passed on, so the later one wins when written.
- **Failure policy.** A malformed conversation is skipped and listed (reason and id only, never text). A non-conversation ZIP is ignored. A non-ZIP or corrupt file is rejected. A truncated file keeps what was read and is marked as a problem.
- **Limits** are in `lib/import/limits.ts`: 400 MB per ZIP, 64 MB per conversation, 2 GB decompressed per entry, 20 files.

**Fixed while building**

- Thread selection returned nothing when a message from an unknown sender was the latest leaf. Senders are now filtered before the thread is traced.
- The ZIP signature check used `instanceof`, which fails for bytes created in another realm. It now duck-types.

**Verified**

- Unit tests for the splitter (chunk boundaries at every size, limits, truncation), the adapter and the pipeline, including a 1,000-conversation archive.
- In headless Chrome, production build: a 1,000-conversation synthetic archive (4.3 MB compressed) plus a non-conversation ZIP and a non-ZIP file. Parsed in about 1.4 seconds; page heap about 28 MB afterwards; the worker loads under the Content Security Policy with no console errors.

**Not verified**

- Archives in the hundreds of megabytes. The largest tested is tens of megabytes of JSON.
- The real export in a browser. It was run through the same pipeline in Node only.
- Safari and Firefox.

## Milestone 3: Authentication and security (14 November 2026)

**Objective.** Accounts, a guarded application shell, Firestore Security Rules for the whole schema, the server-side auth guard, and tests for all of it.

**Decisions**

- **Bearer ID tokens, no session cookies.** The Firebase SDK holds the session in the browser. API routes verify the token with revocation checking. No cookies means no CSRF surface. Protected pages render a loading state until the session is known.
- **Email verification is required** for every Firestore write (rules) and every API route (`withAuth` returns 403).
- **`withAuth` is the only way to export a route handler.** `tests/unit/api-routes-guarded.test.ts` fails if any method in `app/api` is exported without it. The handler receives `uid` from the token; nothing from the request can override it.
- **`userDocPath` builds server-side Firestore paths** from the token's uid and validates client-supplied identifiers, so an id can never contain a slash.
- **`authFetch` retries once with a fresh token on 401 or 403.** Found during browser testing: right after email confirmation, the cached token can still carry `email_verified: false`.
- **Rules use path ownership, not an owner field.** There is nothing for a client to forge; documents that include an owner field are rejected as unknown fields.
- **Server-owned collections are client read-only:** `tasks` (create), `projects` (create), `jobs`, `usage`, `reports`, and the `analysis` field on conversations.
- **Account enumeration is avoided.** Sign-in errors share one message; password reset always shows the same confirmation.
- **Minimum password length is 10 characters**, checked in the form. Firebase's own minimum is lower; raise it in the console under Authentication, Settings, Password policy to enforce it server-side.
- **Static Content Security Policy without nonces.** Nonces would force every page to render per request. The cost is `'unsafe-inline'` for scripts. To revisit in Milestone 10.
- **The Firestore SDK's connectivity probe image (`google.com/images/cleardot.gif`) is blocked by the CSP.** It is only requested when the connection is already failing, and it is not needed.
- **Admin SDK uses no credentials when emulator variables are set**, and refuses to start that way on Vercel.

**How the rules tests run**

`npm run test:rules` starts the Firestore emulator and runs `tests/rules`. The emulator binary could not be downloaded in the environment where this milestone was written, so these tests were executed in GitHub Actions (job `security-rules`), not locally. See the pull request for the run.

**Verified in a browser (auth emulator, production build)**

Signed-out visit to `/dashboard` redirects to `/login`; weak password rejected; registration lands on `/verify-email`; an unverified account cannot reach `/dashboard`; confirming the email unlocks the dashboard; `/api/session` returns the token's uid; signed-in visit to `/login` redirects to `/dashboard`; sign-out returns to `/login`; wrong password shows the shared message; password reset for an unknown address shows the neutral confirmation.

**Not verified**

- Profile creation (`users/{uid}`) against Firestore in a browser. The rule that governs it is covered by the emulator tests; the browser path needs the Firestore emulator or the real project.
- Anything against the real Firebase project. Verification and reset emails were exercised only through the emulator.

## Milestone 2: Project foundation (14 November 2026)

**Objective.** Turn the `create-next-app` scaffold into a project the remaining milestones can build on: dependencies, UI base, configuration validation, Firebase initialisation, tests and CI.

**Decisions**

- **Kept the scaffold's root-level `app/` and `@/*` alias.** No `src/` directory.
- **Kept `@tailwindcss/turbopack`.** The scaffold wires Tailwind 4 through a Turbopack loader instead of the PostCSS plugin shown in the bundled Next.js docs. It works, so it stays.
- **shadcn/ui set up by hand.** The shadcn registry was not reachable from the build environment, so `components.json`, the `cn` helper, the theme variables and `Button` were written to the shadcn conventions. `components.json` has not been validated by the CLI. If `npx shadcn@latest add <component>` rejects it locally, run `npx shadcn@latest init` and keep the variables in `app/globals.css`.
- **`@types/node` raised from 20 to 22.** Vitest 5 requires it and the runtime is Node 22.
- **Geist fonts self-hosted through the `geist` package** instead of `next/font/google`, so builds do not depend on reaching Google Fonts.
- **Environment variables validated with Zod, lazily.** `lib/env/client.ts` and `lib/env/server.ts` parse on first use, so `next build` succeeds without secrets and a missing variable fails with its name.
- **`GEMINI_API_KEY` optional until Milestone 6.** `ALLOWED_EMAILS` defaults to nobody.
- **`server-only` guards** on `lib/env/server.ts` and `lib/firebase/admin.ts`. Vitest aliases the package to an empty stub.
- **Explicit layout prop types** instead of the generated `LayoutProps` global, so `tsc --noEmit` passes before a build has generated route types.
- **Dependencies installed only when a milestone uses them.** JSZip, the streaming JSON parser, `@google/genai` and `firebase-tools` arrive with Milestones 3, 4 and 6.

**Deferred**

- Security headers and Content Security Policy: Milestone 3, with authentication.
- `firestore.rules`, emulator configuration and rules tests: Milestone 3.

**Results**

See the pull request description for the commands run and their output.

## Milestone 1: Architecture (14 November 2026)

Approved. See `ARCHITECTURE.md`.

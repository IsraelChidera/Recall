# Development notes

Decisions and verified results per milestone. Newest milestone first.

## Milestone 9: Resume execution (15 November 2026)

**Objective.** Let the user pick a task back up: show where it was left, write a continuation prompt from the saved conversation, and link back to the original chat.

**What was built**

- `lib/resume/context.ts`: retrieves the context for a task from the stored conversation: the message the commitment was found in, two messages either side, the last four messages, and the project's recorded decisions. Pure function, shared by browser and tests.
- `lib/resume/prompt.ts`: the template that arranges that context into a prompt. It only arranges; it writes no claim of its own about the work.
- `/resume/[taskId]`: the context, the prompt, Copy prompt, Open the original chat, Open a new chat, Mark as in progress. Reached from a Resume button on approved and in-progress tasks.
- Optional AI step, `POST /api/tasks/{taskId}/resume` (`lib/server/resume/generate.ts`): one request to the quality model over a redacted excerpt of the one source conversation. It returns points under three headings (done or worked out, decided, still open), each with a quote. The result is saved on the task (`resume`) so reopening the page spends nothing.

**Decisions**

- **The template is the default, not the fallback.** The prompt is complete and usable with no AI request. The master prompt asked for generation "with template fallback"; here the AI step only adds points to the template, so a quota limit, a provider failure or missing consent never blocks resuming.
- **No unsupported statement can reach the prompt.** The model is asked only for points with an exact quote and a message label. Each is checked with the same verifier as discoveries, against the messages the model was actually shown; a point that fails is dropped. The model writes no free-text summary and no next step. The stand-in model deliberately returns one invented point, and the tests show it never appears.
- **Text that will be pasted elsewhere is redacted.** Context excerpts pass through the same redaction as AI requests (secrets, email addresses, long numbers). The prompt says so, since it otherwise claims word-for-word copying.
- **Honest about what Recall can do.** The page states that Recall cannot open or continue a chat. The links open claude.ai in a new tab; nothing is sent there by Recall. "Open a new chat" is a plain link to `https://claude.ai/new` with no prompt in the address.
- **The prompt tells the assistant it lacks the earlier conversation**, to rely only on what is shown and to ask when something is missing.
- **Limits apply.** The AI step needs consent, an allowed account and a conversation not left out of analysis; it is counted against the per-user and shared daily caps, and makes no request once either is reached.
- **Long conversations.** One request, at most about 60,000 characters: the neighbourhood of the commitment plus the end of the conversation. The model is told when it sees only part.
- **Copying.** Uses the clipboard API, falls back to the older copy command, and if both are refused leaves the prompt selected with instructions.
- **No rule or index change.** The `resume` field is server-written; the task review rule checks only the keys a user changes.

**Verified**

- 203 unit tests pass (19 new: context selection, redaction, prompt wording, excerpt selection for long conversations, defensive reading of saved points).
- Emulator tests in CI (94 passing): context read under the security rules and refused for another user; verified points saved and one request counted; refusal without consent, for unknown tasks, for another user's task id, for a left-out conversation and at either daily cap; provider failures save nothing; a user can still review a task that has saved points.
- Browser test in CI (16 steps, all passing): open Resume from Execution, prompt contains the real quote and neighbouring reply, the original-chat link is correct, the AI step adds verified points and not the invented one, Copy prompt succeeds and the clipboard content equals the prompt. Screenshots reviewed on desktop and at 390 px.

**Not verified**

- The AI step against real Gemini: prompt quality, how often its quotes verify, and whether the quality model name is valid.
- Whether pasting the prompt into Claude produces a good continuation. This needs a person with a real task.
- The clipboard API path itself: the CI browser refused it, so the test exercised the fallback copy command.
- Conversations longer than the 60,000 character excerpt, beyond the unit tests of the selection.
- A task merged from several conversations uses only its primary source conversation for context.

## Milestone 8: Execution dashboard (15 November 2026)

**Objective.** Turn approved discoveries into something the user works from: a daily overview, an Execution Inbox, Forgotten Work and a weekly report.

**What was built**

- `lib/discoveries/insights.ts`: pure functions for ISO weeks, forgotten-work scoring, priority suggestions, the dashboard summary, the weekly report and grouping. No Firebase, no clock of its own (the caller passes `now`), so every rule is unit tested.
- `loadWorkspace` in `lib/discoveries/store.ts`: three queries (open tasks, completed tasks, projects) feed all four screens. Dismissed tasks are never loaded.
- `/execute` (group by priority, project or status; Start, Pause, Mark as done), `/forgotten`, `/weekly` (this week and last week) and the overview at the top of `/dashboard`.
- Reminders: a "Remind me on" date on the task edit form, stored in the existing `remindOn` field. It only surfaces on the dashboard and in the suggested priorities. Recall sends no email or notification.

**Decisions**

- **The weekly report makes no AI request.** The architecture planned one Gemini request per report, cached in `reports`. The report is now computed from task data each time it is opened. It costs nothing, cannot invent anything and is available offline from quota. The `reports` collection stays unused. Recorded as an amendment.
- **Forgotten is not the same as old.** A task qualifies only if it is open, its conversation has been quiet for 21 days or more, and its score reaches 0.3. Score = commitment strength x staleness (saturating at 180 days) x confidence, with approved work weighted above unreviewed work. Vague ideas (`uncertain`) score too low to appear at any age. Every item shows its reason in plain words.
- **"This week" counts the user's own decisions.** Completed and taken-on counts use `lastReviewedAt`, which only the user's actions set. Work the analysis recorded as already done is not credited to the week.
- **Suggested priorities are rules, with the reason shown**: a due reminder first, then work already started, then priority, then staleness; ties break alphabetically so the order is stable.
- **No new Firestore index or rule.** `remindOn` and `in_progress` were already permitted by the rules; the workspace queries use single-field filters only.

**Verified**

- 184 unit tests pass (26 new for insights, including ISO week year boundaries).
- Emulator tests in CI: reminder set and cleared under the security rules, `in_progress` transitions, `loadWorkspace` contents, and refusal for another user.
- Browser test in CI (15 steps, all passing): approve in the Inbox, start the task on Execution, set a reminder, regroup, see it under Forgotten with its reason, weekly report, dashboard overview on desktop and at 390 px. Screenshots reviewed from the CI log.
- Lint, typecheck and production build pass.

**Not verified**

- Behaviour with real data: every figure on these screens so far comes from one synthetic task.
- The 300 open / 200 completed task caps in `loadWorkspace` are untested at volume. Beyond them the counts would be understated without warning.
- Weeks are ISO weeks in UTC. For a user in Lagos (UTC+1) the week turns over at 01:00 on Monday, not midnight.
- The emulator stall noted in Milestone 7 still appears (three steps took about 30 seconds each).

## Milestone 7: Discovery interface (15 November 2026)

**Objective.** Let the user review what was discovered: approve, dismiss, edit, re-prioritise, assign to a project, and see projects with their decisions and conversations.

**What was built**

- **Inbox** (`/inbox`) with four lists: To review, Approved, Done, Dismissed. Each discovery shows its quotes with the date and an "Open in Claude" link, the suggested next step, and a note when Recall is unsure or when a later message suggests the work is done.
- **Review actions**: approve, dismiss, restore, mark as done, reopen, move back to review, and edit (title, notes, priority, project). Each status change can be undone from a notice. Every decision is written with an activity log entry in one batch.
- **Projects** (`/projects`, `/projects/{id}`): description, outstanding tasks, decisions with their quotes, completed work, related conversations with links, suggested next steps; rename, describe, archive.
- **Validation mirrors the security rules** (`lib/discoveries/model.ts`), so a bad edit is explained in the form instead of being refused by the server.
- **`scripts/set-service-account.mjs`** writes the service account into `.env.local` in the correct format. Added after a hand-pasted key turned out not to be a private key.

**Decisions**

- Review writes go straight from the browser under the security rules. Users can change only status, priority, wording, project and review time; evidence, confidence and source stay server-owned.
- Projects cannot be created by hand. A task can be assigned to any discovered project or to none.
- The app shell sits inside a Suspense boundary. It reads the current path, which on a dynamic route is only known at request time; without the boundary the production build fails.
- Per-tab counts are loaded one after another, like the dashboard overview.

**Verified**

- Unit tests for reading documents defensively, link building, patches and validation.
- Emulator tests with rules on (`tests/rules/review-store.test.ts`): list, approve, dismiss and restore, edit without touching evidence, assign and unassign a project, mark done, load and edit a project, isolation from another user, pagination.
- Browser test: edit, approve, undo, approve in the Inbox, checked against the stored document; project page shows outstanding work and conversations.
- **Screens inspected.** The browser test now copies screenshots into the CI log, which made it possible to look at the Inbox, the edit form, the project page (desktop and 390 px), the analysis panel and the saved-import screen. Fixed from that review: navigation overflowing on narrow screens, an empty gap above the Inbox list, and stale wording on the saved-import screen.

**Not verified**

- Real findings. Everything shown so far comes from the stand-in model on synthetic conversations.
- The four Firestore composite indexes in production. The emulator does not require indexes, so a missing index would only show against the real project.

## Per-user AI limits (15 November 2026)

**Why.** The Gemini quota belongs to the project, so one daily cap per user does not protect it once there is more than one user: each could use the whole allowance.

**What changed**

- **Two daily limits.** `AI_DAILY_REQUEST_CAP` (default 450) is shared by all users. `AI_USER_DAILY_REQUEST_CAP` (default 150) applies to each user and is never more than the shared cap. A request must fit under both.
- **Two counters,** written together in one batch: `users/{uid}/usage/{day}` (readable by its owner) and top-level `usage/{day}` (no client access; the rules deny it because the path is not listed, and a test asserts it).
- **The pause message says which limit was reached.**
- **`ALLOWED_EMAILS=*`** admits every verified account. Empty still means nobody.

**Limits that exist today**

| Limit | Default | Where |
| --- | --- | --- |
| AI requests per user per day | 150 | `AI_USER_DAILY_REQUEST_CAP` |
| AI requests for all users per day | 450 | `AI_DAILY_REQUEST_CAP` |
| AI requests per minute, per running job | 10 | `AI_REQUESTS_PER_MINUTE` |
| AI requests per server call | 4 | `AI_REQUESTS_PER_ADVANCE` |
| Conversations indexed per user | 16,000 | `lib/import/plan.ts`, enforced in `firestore.rules` |
| Upload size | 400 MB per ZIP, 20 files | `lib/import/limits.ts` |
| Password length | 10 characters minimum | sign-up form |

**Known gap.** The per-minute pace is per job. Several users analysing at the same moment can together exceed the provider's per-minute limit; the provider then answers 429 and each job waits and retries, so work is delayed, not lost. The shared daily cap is checked when a server call starts, so concurrent users can overshoot it by a few requests.

## Milestone 6: AI intelligence (15 November 2026)

**Objective.** Discover unfinished work in the saved conversations with an AI model, store only what can be verified against the source text, and stay inside the free quota.

**How it works**

- **Provider interface** (`lib/ai/provider.ts`). `GeminiProvider` is the real implementation; `FakeProvider` is a deterministic stand-in that reads the same prompts and answers by pattern rules, so tests exercise the whole pipeline. The fake is refused on a deployed site.
- **Jobs** (`lib/server/analysis/job.ts`). `POST /api/jobs` starts or resumes a job; `POST /api/jobs/{id}/advance` does a bounded slice of work under a short lease. The browser tab calls it in a loop and waits as long as the response says. Closing the tab stops the loop; the job continues from its saved state next time.
- **Stages.** Prefilter (no AI) drops excluded and trivial conversations. Screening sends digests in batches. Extraction reads each shortlisted conversation as a numbered, redacted transcript, in overlapping windows when long. Reconciliation merges near-duplicate tasks. Persistence writes tasks and projects with the Admin SDK.
- **Nothing from the model is trusted.** Messages are numbered for the model, which never sees an identifier. Every quote must be found in the message it cites. Deadlines and completions that cannot be verified are dropped while the task itself is kept. Malformed items are discarded individually.
- **User decisions outrank the model.** A dismissed task stays dismissed. A task you approved is never silently completed; a verified completion is recorded as a suggestion.
- **Consent and privacy.** Nothing is sent until the consent statement is accepted (`AI_CONSENT_VERSION`). Excluded conversations are never sent. Emails, phone numbers, long numbers and credential-shaped strings are redacted first.
- **Quota.** `users/{uid}/usage/{day}` counts requests per Pacific-time day, server-written only. Jobs pause at `AI_DAILY_REQUEST_CAP` and resume later. Per-minute pacing is returned to the client as a wait.

**Configuration.** Model names and limits are environment variables with conservative defaults (see `.env.example`). They must be set from the limits AI Studio shows for the project.

**Verified**

- Unit tests: redaction, transcripts and windows, quote verification, discovery rules, configuration, and the Gemini provider against a stand-in SDK client (schema passing, model choice, error classification).
- Emulator tests (`tests/rules/analysis-pipeline.test.ts`, 17 tests) through the real job code with the Admin SDK: guards, a full run, privacy, an untrustworthy model, quota and resuming, single-caller leasing, re-analysis after a newer export, and deletion.
- Browser tests: consent gate, leaving a conversation out, a full analysis showing findings with their quotes, and deletion of discoveries.

**Not verified**

- **No request has been made to the real Gemini API.** The model names `gemini-3.5-flash-lite` and `gemini-3.8-flash` come from third-party reports and are unconfirmed for this project. Whether the model honours the JSON schema at this prompt size, and how good its extraction is, is unknown until a live run.
- Extraction quality. The fake provider proves the plumbing and the safeguards, not the usefulness of real findings.
- The analysis panel has been driven by the browser tests but not inspected by eye.

**Open issue: stalled requests on the emulator**

In the browser tests, one streamed Firestore request per session is held by the emulator for 45 to 60 seconds before it answers. Request tracing showed the long-poll channel requests pending at the emulator with only three connections open, so it is not the browser's connection limit. Switching transport, shortening long-poll cycles and loading the overview sequentially moved the stall but did not remove it. The tests pass because their waits allow for it. I believe it is specific to the emulator, but I have not proven that. Watch for a long pause on the dashboard when running against the real project.

## Milestone 5: Data persistence (14 November 2026)

**Objective.** Save imported conversations to Firestore from the browser, idempotently and resumably, and let the user see and delete what is saved.

**Decisions**

- **Planning is pure** (`lib/import/plan.ts`): classify against the index, plan counts, shard ids, chunking. No Firestore imports, so it is unit-tested directly.
- **The writer runs under the user's security rules** (`lib/import/firestore-writer.ts`), not through the server. Its emulator tests run with rules enabled, so every document it writes is proven to satisfy them.
- **Atomic batches.** Up to 20 conversations, their chunks, the touched index shards and the import's progress commit together.
- **Updates preserve** `createdAt` and the user's `excluded` choice, set `needsAnalysis`, and delete chunks the shorter version no longer needs (the previous chunk count is read first; one read per changed conversation).
- **An identical re-import performs zero writes**, not even an import record.
- **Deletion is paged and atomic per page** (conversations, chunks and index entries together), so stopping midway leaves a consistent state and repeating continues.
- **No browser dialogs.** Deletion is confirmed inline.

**Cost of the real export (62 conversations).** About 62 conversation writes, about 62 chunk writes, up to 8 index writes per batch over 4 batches, and a handful for the import, source and activity log: roughly 165 writes and under 20 reads.

**How it was verified**

The Firestore emulator could not be downloaded where this was written, so everything that needs it ran in GitHub Actions:

- `security-rules` job: 9 writer tests (first import, identical re-import, newer export, preserved fields, shrinking conversation, interrupted and resumed import, delete one import, delete everything across pages) alongside the 46 rules tests.
- `browser` job (new): headless Chrome against a production build and both emulators. Sign in, profile creation, preview, save, identical re-import, incremental import and delete-all, each checked against the documents actually stored, plus an assertion that the browser console logged no errors.

**Not verified**

- The saving and history screens were exercised by the browser tests but not looked at by eye. Layout problems there would not have been caught.
- Behaviour when the connection drops mid-save. The Firestore SDK queues writes while offline, so the progress bar would stall until the connection returns.
- Anything against the real Firebase project.

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

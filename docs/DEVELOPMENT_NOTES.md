# Development notes

Decisions and verified results per milestone. Newest milestone first.

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

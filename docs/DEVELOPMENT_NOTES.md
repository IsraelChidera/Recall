# Development notes

Decisions and verified results per milestone. Newest milestone first.

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

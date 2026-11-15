import "server-only";

import { z } from "zod";

import { EnvError } from "./client";

/**
 * Server-only secrets. Never prefix these with NEXT_PUBLIC_.
 *
 * GEMINI_API_KEY is optional here so the app can run with the stand-in
 * provider; the AI pipeline checks for it before making any real request.
 */
export const serverEnvSchema = z.object({
  FIREBASE_PROJECT_ID: z.string().min(1),
  FIREBASE_CLIENT_EMAIL: z.string().min(1),
  FIREBASE_PRIVATE_KEY: z.string().min(1),
  GEMINI_API_KEY: z.string().min(1).optional(),
  /** Comma-separated emails allowed to use AI analysis. Empty means nobody. */
  ALLOWED_EMAILS: z.string().optional(),
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

export function parseServerEnv(raw: Record<string, string | undefined>): ServerEnv {
  const result = serverEnvSchema.safeParse(raw);
  if (!result.success) {
    throw new EnvError(
      "server",
      result.error.issues.map((issue) => issue.path.join(".")),
    );
  }
  return {
    ...result.data,
    // Vercel stores multi-line secrets with escaped newlines.
    FIREBASE_PRIVATE_KEY: result.data.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
  };
}

/** Parse the allowlist into lower-cased, trimmed addresses. */
export function parseAllowedEmails(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter((email) => email.length > 0);
}

let cached: ServerEnv | undefined;

export function getServerEnv(): ServerEnv {
  cached ??= parseServerEnv({
    FIREBASE_PROJECT_ID: process.env.FIREBASE_PROJECT_ID,
    FIREBASE_CLIENT_EMAIL: process.env.FIREBASE_CLIENT_EMAIL,
    FIREBASE_PRIVATE_KEY: process.env.FIREBASE_PRIVATE_KEY,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    ALLOWED_EMAILS: process.env.ALLOWED_EMAILS,
  });
  return cached;
}

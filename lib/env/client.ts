import { z } from "zod";

/**
 * Public Firebase web configuration.
 *
 * These values are safe to ship to the browser: Firestore Security Rules, not
 * secrecy, protect the data. Each variable is read with a literal
 * `process.env.NEXT_PUBLIC_*` reference so Next.js can inline it at build time.
 */
export const clientEnvSchema = z.object({
  NEXT_PUBLIC_FIREBASE_API_KEY: z.string().min(1),
  NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: z.string().min(1),
  NEXT_PUBLIC_FIREBASE_PROJECT_ID: z.string().min(1),
  NEXT_PUBLIC_FIREBASE_APP_ID: z.string().min(1),
  NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID: z.string().min(1).optional(),
  NEXT_PUBLIC_USE_FIREBASE_EMULATORS: z.enum(["true", "false"]).optional(),
});

export type ClientEnv = z.infer<typeof clientEnvSchema>;

export class EnvError extends Error {
  constructor(scope: "client" | "server", missing: string[]) {
    super(
      `Invalid ${scope} environment. Check these variables: ${missing.join(", ")}. See .env.example.`,
    );
    this.name = "EnvError";
  }
}

export function parseClientEnv(raw: Record<string, string | undefined>): ClientEnv {
  const result = clientEnvSchema.safeParse(raw);
  if (!result.success) {
    throw new EnvError(
      "client",
      result.error.issues.map((issue) => issue.path.join(".")),
    );
  }
  return result.data;
}

let cached: ClientEnv | undefined;

export function getClientEnv(): ClientEnv {
  cached ??= parseClientEnv({
    NEXT_PUBLIC_FIREBASE_API_KEY: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
    NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
    NEXT_PUBLIC_FIREBASE_PROJECT_ID: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
    NEXT_PUBLIC_FIREBASE_APP_ID: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
    NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID:
      process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
    NEXT_PUBLIC_USE_FIREBASE_EMULATORS:
      process.env.NEXT_PUBLIC_USE_FIREBASE_EMULATORS,
  });
  return cached;
}

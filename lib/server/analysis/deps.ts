import "server-only";

import { getAIConfig } from "@/lib/ai/config";
import { getAIProvider } from "@/lib/ai";
import { getAdminDb } from "@/lib/firebase/admin";

import type { AnalysisDeps } from "./types";

/** The real dependencies: Admin Firestore, the configured provider, the wall clock. */
export function getAnalysisDeps(): AnalysisDeps {
  const config = getAIConfig();
  return {
    db: getAdminDb(),
    provider: getAIProvider(config),
    config,
    now: () => new Date(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

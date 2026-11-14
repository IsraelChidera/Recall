import "server-only";

import type { Firestore } from "firebase-admin/firestore";

import type { AIConfig } from "@/lib/ai/config";
import type { AIProvider } from "@/lib/ai/provider";

export { EMPTY_PROGRESS } from "@/lib/domain/job";
export type { JobProgress, JobStage, JobStatus, JobView } from "@/lib/domain/job";

/** Everything the pipeline needs from outside, injected so tests can replace it. */
export type AnalysisDeps = {
  db: Firestore;
  provider: AIProvider;
  config: AIConfig;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
};

export const userPath = (uid: string, ...segments: string[]) =>
  ["users", uid, ...segments].join("/");

export { AI_CONSENT_VERSION } from "@/lib/domain/consent";

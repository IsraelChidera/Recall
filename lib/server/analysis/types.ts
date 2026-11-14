import "server-only";

import type { Firestore } from "firebase-admin/firestore";

import type { AIConfig } from "@/lib/ai/config";
import type { AIProvider } from "@/lib/ai/provider";

export type JobStatus = "running" | "paused_quota" | "paused_error" | "completed";
export type JobStage = "screening" | "extraction" | "reconciliation" | "done";

export type JobProgress = {
  screened: number;
  shortlisted: number;
  skipped: number;
  analysed: number;
  failed: number;
  tasksCreated: number;
  tasksUpdated: number;
  tasksCompleted: number;
  tasksMerged: number;
  /** Model output dropped because its quote could not be found in the conversation. */
  discarded: number;
  aiRequests: number;
};

export const EMPTY_PROGRESS: JobProgress = {
  screened: 0,
  shortlisted: 0,
  skipped: 0,
  analysed: 0,
  failed: 0,
  tasksCreated: 0,
  tasksUpdated: 0,
  tasksCompleted: 0,
  tasksMerged: 0,
  discarded: 0,
  aiRequests: 0,
};

/** What the browser is told about a job. No conversation content. */
export type JobView = {
  id: string;
  status: JobStatus;
  stage: JobStage;
  progress: JobProgress;
  /** Why the job is paused, in words a user can act on. */
  message: string | null;
  /** The browser should wait this long before calling again. */
  waitMs: number;
  usage: { day: string; aiRequests: number; dailyCap: number };
};

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

/** Bumped when the consent text changes materially; users are asked again. */
export const AI_CONSENT_VERSION = 1;

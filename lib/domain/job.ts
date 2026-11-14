/**
 * The shape of an analysis job as shared between the server and the browser.
 */
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

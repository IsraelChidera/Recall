import type { NormalisedConversation } from "@/lib/domain/conversation";

import type { ImportProgress, ImportResult } from "./parse-export";

/** Messages between the page and the import worker. */
export type ImportWorkerRequest =
  | { type: "start"; files: File[] }
  /** Sent after a batch has been handled; the worker then reads further. */
  | { type: "ack" };

export type ImportWorkerResponse =
  | { type: "progress"; progress: ImportProgress }
  | { type: "batch"; conversations: NormalisedConversation[] }
  | { type: "done"; result: ImportResult }
  | { type: "error"; message: string };

/** A batch is flushed at whichever limit is reached first. */
export const BATCH_LIMITS = {
  conversations: 20,
  characters: 1_500_000,
} as const;

import { z } from "zod";

/**
 * Source-independent shape every importer produces. Timestamps are ISO-8601
 * strings so values can cross the worker boundary unchanged; they become
 * Firestore timestamps when written.
 */
export const ASSISTANT_TEXT_LIMIT = 4_000;
export const HUMAN_TEXT_LIMIT = 50_000;
export const TITLE_LIMIT = 500;
export const DIGEST_LIMIT = 4_000;

export const normalisedMessageSchema = z.object({
  id: z.string().min(1).max(128),
  sender: z.enum(["human", "assistant"]),
  createdAt: z.string().nullable(),
  text: z.string(),
  /** True when `text` was cut to the storage limit for its sender. */
  truncated: z.boolean(),
  attachmentCount: z.number().int().nonnegative(),
  toolUseCount: z.number().int().nonnegative(),
});

export const normalisedConversationSchema = z.object({
  /** Recall document id: `<sourceId>_<source conversation id>`. */
  id: z.string().min(1).max(128),
  sourceId: z.string().min(1).max(32),
  sourceConversationId: z.string().min(1).max(128),
  title: z.string().max(TITLE_LIMIT),
  createdAtSource: z.string().nullable(),
  updatedAtSource: z.string().nullable(),
  sourceUrl: z.string().max(300).nullable(),
  /** Short text for AI screening: title, source summary, first and last human messages. */
  digest: z.string().max(DIGEST_LIMIT),
  contentHash: z.string().min(1).max(128),
  messageCount: z.number().int().nonnegative(),
  humanMessageCount: z.number().int().nonnegative(),
  /** Messages on abandoned branches (edits, regenerations) that were left out. */
  offBranchMessageCount: z.number().int().nonnegative(),
  messages: z.array(normalisedMessageSchema),
});

export type NormalisedMessage = z.infer<typeof normalisedMessageSchema>;
export type NormalisedConversation = z.infer<typeof normalisedConversationSchema>;

/** What the Import Centre needs to show a conversation without its text. */
export type ConversationSummary = Omit<NormalisedConversation, "messages" | "digest">;

export function summarise(conversation: NormalisedConversation): ConversationSummary {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- text is dropped on purpose
  const { messages, digest, ...summary } = conversation;
  return summary;
}

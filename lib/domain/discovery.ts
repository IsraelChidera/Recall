import { z } from "zod";

/**
 * What the AI pipeline may discover, and the rules for turning model output
 * into stored tasks. Pure: no Firestore, no network.
 */

export const TASK_CATEGORIES = [
  "unfinished_project",
  "explicit_commitment",
  "pending_action",
  "unfinished_deliverable",
  "future_intention",
  "follow_up",
  "abandoned_conversation",
] as const;

export const TASK_STATUSES = [
  "awaiting_review",
  "approved",
  "in_progress",
  "completed",
  "dismissed",
] as const;

export const PRIORITIES = ["low", "medium", "high"] as const;
export const PRIORITY_RANK = { low: 1, medium: 2, high: 3 } as const;

/** How strongly the user committed. Only the last three become tasks. */
export const COMMITMENT_CLASSES = [
  "brainstorm",
  "interest",
  "uncertain",
  "intention",
  "explicit_commitment",
  "active_execution",
] as const;

export type TaskCategory = (typeof TASK_CATEGORIES)[number];
export type TaskStatus = (typeof TASK_STATUSES)[number];
export type Priority = (typeof PRIORITIES)[number];
export type CommitmentClass = (typeof COMMITMENT_CLASSES)[number];

const TASK_WORTHY: ReadonlySet<CommitmentClass> = new Set([
  "intention",
  "explicit_commitment",
  "active_execution",
]);

export function becomesTask(commitmentClass: CommitmentClass): boolean {
  return TASK_WORTHY.has(commitmentClass);
}

/** A message reference as shown to the model: m1, m2, ... Never a database id. */
const messageRef = z.string().regex(/^m\d{1,4}$/);

// ---- Stage 1: screening ----------------------------------------------------

export const screeningOutputSchema = z.object({
  results: z.array(
    z.object({
      n: z.number().int().min(1),
      keep: z.boolean(),
      reason: z.string().max(300),
    }),
  ),
});
export type ScreeningOutput = z.infer<typeof screeningOutputSchema>;

// ---- Stage 2: extraction ---------------------------------------------------

export const extractedItemSchema = z.object({
  title: z.string().min(3).max(140),
  description: z.string().max(600),
  category: z.enum(TASK_CATEGORIES),
  commitmentClass: z.enum(COMMITMENT_CLASSES),
  priority: z.enum(PRIORITIES),
  evidenceRef: messageRef,
  evidenceQuote: z.string().min(8).max(500),
  suggestedNextAction: z.string().max(300),
  /** ISO date, only when the user stated one. */
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  dueDateQuote: z.string().max(300).nullable(),
  completed: z.boolean(),
  completionRef: messageRef.nullable(),
  completionQuote: z.string().max(500).nullable(),
});
export type ExtractedItem = z.infer<typeof extractedItemSchema>;

export const extractedDecisionSchema = z.object({
  text: z.string().min(3).max(300),
  ref: messageRef,
  quote: z.string().min(8).max(500),
});
export type ExtractedDecision = z.infer<typeof extractedDecisionSchema>;

export const existingTaskUpdateSchema = z.object({
  /** t1, t2, ... as listed in the prompt. */
  ref: z.string().regex(/^t\d{1,3}$/),
  state: z.enum(["completed", "still_open", "no_longer_relevant"]),
  evidenceRef: messageRef.nullable(),
  evidenceQuote: z.string().max(500).nullable(),
});
export type ExistingTaskUpdate = z.infer<typeof existingTaskUpdateSchema>;

/** The schema sent to the model. Strict, so the model is told exactly what to return. */
export const extractionOutputSchema = z.object({
  project: z
    .object({ name: z.string().min(2).max(80), description: z.string().max(400) })
    .nullable(),
  items: z.array(extractedItemSchema).max(12),
  decisions: z.array(extractedDecisionSchema).max(10),
  existingTasks: z.array(existingTaskUpdateSchema).max(30),
});
export type ExtractionOutput = z.infer<typeof extractionOutputSchema>;

/**
 * The schema used to READ a response. Lists are parsed element by element, so
 * one malformed item is dropped instead of discarding the whole response.
 */
const looseList = z.array(z.unknown()).catch([]);
export const extractionEnvelopeSchema = z.object({
  project: extractionOutputSchema.shape.project.catch(null),
  items: looseList,
  decisions: looseList,
  existingTasks: looseList,
});

export function keepValid<T>(schema: z.ZodType<T>, values: unknown[]): { valid: T[]; dropped: number } {
  const valid: T[] = [];
  let dropped = 0;
  for (const value of values) {
    const parsed = schema.safeParse(value);
    if (parsed.success) valid.push(parsed.data);
    else dropped++;
  }
  return { valid, dropped };
}

// ---- Stage 3: reconciliation -----------------------------------------------

export const reconciliationOutputSchema = z.object({
  pairs: z.array(z.object({ n: z.number().int().min(1), same: z.boolean() })),
});
export type ReconciliationOutput = z.infer<typeof reconciliationOutputSchema>;

const STOP_WORDS = new Set([
  "a", "an", "the", "to", "of", "for", "and", "or", "in", "on", "my", "our", "with", "up", "by", "at", "it", "this", "that",
]);

/** Lower-cased content words of a title, for comparing discoveries. */
export function titleTokens(title: string): string[] {
  return title
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}

/** Stable key for "the same task": content words, sorted. */
export function dedupeKey(title: string): string {
  return [...new Set(titleTokens(title))].sort().join(" ");
}

/** Jaccard similarity of two titles' content words, from 0 to 1. */
export function titleSimilarity(a: string, b: string): number {
  const left = new Set(titleTokens(a));
  const right = new Set(titleTokens(b));
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared++;
  return shared / (left.size + right.size - shared);
}

export const SAME_TASK_THRESHOLD = 0.8;
export const MAYBE_SAME_THRESHOLD = 0.45;

// ---- Stage 4: confidence ---------------------------------------------------

export type ConfidenceInput = {
  commitmentClass: CommitmentClass;
  /** Who wrote the message the evidence quote was found in. */
  evidenceSender: "human" | "assistant";
  /** The quote was found in the message the model pointed at, not elsewhere. */
  evidenceRefExact: boolean;
  hasVerifiedDueDate: boolean;
};

const BASE_CONFIDENCE: Record<CommitmentClass, number> = {
  explicit_commitment: 0.8,
  active_execution: 0.75,
  intention: 0.55,
  uncertain: 0.3,
  interest: 0.2,
  brainstorm: 0.1,
};

export const NEEDS_ATTENTION_BELOW = 0.6;

/**
 * Confidence is computed, not taken from the model. A commitment in the
 * user's own words scores higher than one inferred from Claude's reply.
 */
export function scoreConfidence(input: ConfidenceInput): number {
  let score = BASE_CONFIDENCE[input.commitmentClass];
  score += input.evidenceSender === "human" ? 0.1 : -0.15;
  if (!input.evidenceRefExact) score -= 0.05;
  if (input.hasVerifiedDueDate) score += 0.05;
  return Math.round(Math.min(0.95, Math.max(0.05, score)) * 100) / 100;
}

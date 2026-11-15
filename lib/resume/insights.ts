import { z } from "zod";

/**
 * What the optional AI step adds to a continuation prompt: points about the
 * state of the work, each tied to words that really appear in the
 * conversation. A point whose quote cannot be found is discarded on the
 * server, so nothing here is the model's unsupported claim.
 */
export const INSIGHT_KINDS = ["progress", "decision", "open_question"] as const;
export type InsightKind = (typeof INSIGHT_KINDS)[number];

export type InsightPoint = {
  kind: InsightKind;
  text: string;
  quote: string;
  sender: "human" | "assistant";
};

export type ResumeInsights = {
  points: InsightPoint[];
  generatedAt: Date | null;
};

export const INSIGHT_LIMITS = { perKind: 5, textChars: 240, quoteChars: 400 } as const;

const point = z.object({
  text: z.string().min(1).max(600),
  ref: z.string().regex(/^m\d+$/),
  quote: z.string().min(1).max(1_000),
});

/** The shape asked of the model. Lists are capped when read, not rejected. */
export const resumeResponseSchema = z.object({
  progress: z.array(point).max(20).default([]),
  decisions: z.array(point).max(20).default([]),
  openQuestions: z.array(point).max(20).default([]),
});
export type ResumeResponse = z.infer<typeof resumeResponseSchema>;

const asText = (value: unknown) => (typeof value === "string" ? value : "");

/** Reads insights saved on a task. Anything malformed is dropped. */
export function toResumeInsights(value: unknown): ResumeInsights | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const raw = Array.isArray(record.points) ? (record.points as unknown[]) : [];
  const points: InsightPoint[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const item = entry as Record<string, unknown>;
    const kind = INSIGHT_KINDS.find((candidate) => candidate === item.kind);
    const text = asText(item.text).trim();
    const quote = asText(item.quote).trim();
    if (!kind || !text || !quote) continue;
    points.push({ kind, text, quote, sender: item.sender === "assistant" ? "assistant" : "human" });
  }
  const generated = record.generatedAt as { toDate?: () => Date } | Date | string | null | undefined;
  const generatedAt =
    generated instanceof Date
      ? generated
      : typeof generated === "string"
        ? new Date(generated)
        : generated && typeof generated.toDate === "function"
          ? generated.toDate()
          : null;
  return { points, generatedAt: generatedAt && !Number.isNaN(generatedAt.getTime()) ? generatedAt : null };
}

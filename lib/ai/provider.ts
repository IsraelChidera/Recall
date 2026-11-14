import type { z } from "zod";

/**
 * The only interface the pipeline knows about an AI model. Gemini implements
 * it today; a local Ollama provider can implement it later without touching
 * the pipeline.
 */
export type ModelRole =
  /** High-volume work: screening, extraction, reconciliation. */
  | "bulk"
  /** Low-volume work where quality matters most: resume prompts, weekly report. */
  | "quality";

export type StructuredRequest<T> = {
  role: ModelRole;
  system: string;
  prompt: string;
  /** The response must parse against this. */
  schema: z.ZodType<T>;
  /**
   * The schema shown to the model, when it should be stricter than the one
   * used to read the answer. Defaults to `schema`.
   */
  modelSchema?: z.ZodType;
  maxOutputTokens?: number;
};

export type TokenUsage = { inputTokens: number; outputTokens: number };

export type StructuredResponse<T> = { data: T; usage: TokenUsage; model: string };

export interface AIProvider {
  readonly name: string;
  generateStructured<T>(request: StructuredRequest<T>): Promise<StructuredResponse<T>>;
}

/** The provider refused the request because a quota was reached. */
export class AIRateLimitError extends Error {
  constructor(
    /** True when the daily allowance is spent, false for a per-minute limit. */
    readonly daily: boolean,
    readonly retryAfterMs: number | null,
  ) {
    super(daily ? "Daily AI quota reached." : "AI rate limit reached.");
    this.name = "AIRateLimitError";
  }
}

/** The model answered, but not with usable structured data. */
export class AIResponseError extends Error {
  constructor(detail: string) {
    super(`The AI response could not be used: ${detail}`);
    this.name = "AIResponseError";
  }
}

/** The provider is unreachable or failing; worth retrying later. */
export class AIUnavailableError extends Error {
  constructor(detail: string) {
    super(`The AI provider is unavailable: ${detail}`);
    this.name = "AIUnavailableError";
  }
}

/** Rough token estimate for budgeting. About four characters per token. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

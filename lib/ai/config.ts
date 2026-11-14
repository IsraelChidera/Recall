import "server-only";

import { z } from "zod";

/**
 * AI limits and model names. These are configuration, not code, because
 * Google changes free-tier limits without notice. Set them from the numbers
 * your own AI Studio project shows.
 */
const positiveInt = (fallback: number) =>
  z.coerce.number().int().positive().catch(fallback);

const schema = z.object({
  AI_PROVIDER: z.enum(["gemini", "fake"]).catch("gemini"),
  AI_MODEL_BULK: z.string().min(1).catch("gemini-3.5-flash-lite"),
  AI_MODEL_QUALITY: z.string().min(1).catch("gemini-3.8-flash"),
  /**
   * Requests per day across ALL users and models. The Gemini quota belongs to
   * the project, not to a user, so this is the ceiling that protects it.
   */
  AI_DAILY_REQUEST_CAP: positiveInt(450),
  /** Requests per day for any ONE user, so a single account cannot use the whole quota. */
  AI_USER_DAILY_REQUEST_CAP: positiveInt(150),
  /** Requests per minute. Kept below the provider's limit. */
  AI_REQUESTS_PER_MINUTE: positiveInt(10),
  /** Model requests one call to the job route may make. */
  AI_REQUESTS_PER_ADVANCE: positiveInt(4),
});

export type AIConfig = {
  provider: "gemini" | "fake";
  bulkModel: string;
  qualityModel: string;
  /** Shared by every user. */
  dailyRequestCap: number;
  /** For each user. Never more than the shared cap. */
  userDailyRequestCap: number;
  requestsPerMinute: number;
  requestsPerAdvance: number;
};

export function parseAIConfig(raw: Record<string, string | undefined>): AIConfig {
  const env = schema.parse(raw);
  return {
    provider: env.AI_PROVIDER,
    bulkModel: env.AI_MODEL_BULK,
    qualityModel: env.AI_MODEL_QUALITY,
    dailyRequestCap: env.AI_DAILY_REQUEST_CAP,
    userDailyRequestCap: Math.min(env.AI_USER_DAILY_REQUEST_CAP, env.AI_DAILY_REQUEST_CAP),
    requestsPerMinute: env.AI_REQUESTS_PER_MINUTE,
    requestsPerAdvance: env.AI_REQUESTS_PER_ADVANCE,
  };
}

export function getAIConfig(): AIConfig {
  return parseAIConfig({
    AI_PROVIDER: process.env.AI_PROVIDER,
    AI_MODEL_BULK: process.env.AI_MODEL_BULK,
    AI_MODEL_QUALITY: process.env.AI_MODEL_QUALITY,
    AI_DAILY_REQUEST_CAP: process.env.AI_DAILY_REQUEST_CAP,
    AI_USER_DAILY_REQUEST_CAP: process.env.AI_USER_DAILY_REQUEST_CAP,
    AI_REQUESTS_PER_MINUTE: process.env.AI_REQUESTS_PER_MINUTE,
    AI_REQUESTS_PER_ADVANCE: process.env.AI_REQUESTS_PER_ADVANCE,
  });
}

/**
 * The quota day. Gemini's daily limits reset at midnight Pacific time, so
 * usage is counted per Pacific calendar day.
 */
export function usageDay(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

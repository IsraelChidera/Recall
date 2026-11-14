import { describe, expect, it } from "vitest";

import { parseAIConfig, usageDay } from "@/lib/ai/config";
import { redact } from "@/lib/ai/redact";
import { renderMessage, toPromptMessages, TRANSCRIPT_LIMITS, windowMessages } from "@/lib/ai/transcript";
import { normaliseForMatch, verifyQuote } from "@/lib/ai/verify";
import {
  becomesTask,
  dedupeKey,
  extractedItemSchema,
  keepValid,
  scoreConfidence,
  titleSimilarity,
} from "@/lib/domain/discovery";
import type { StoredMessage } from "@/lib/import/plan";

const stored = (id: string, sender: "human" | "assistant", text: string): StoredMessage => ({
  id,
  sender,
  createdAt: "2026-03-01T10:00:00.000Z",
  text,
  truncated: false,
});

describe("redact", () => {
  it.each([
    ["Reach me at jane.doe+work@example.co.uk please", "jane.doe"],
    ["Call +234 803 123 4567 tomorrow", "803 123 4567"],
    ["Card 4111 1111 1111 1111 on file", "4111 1111"],
    ["Account 0123456789 at the bank", "0123456789"],
    ["key sk-proj-abcdefghijklmnopqrstuvwx1234", "abcdefghijklmnop"],
    ["AIzaSyA1234567890abcdefghijklmnopqrstuvw", "AIzaSyA"],
    ["token ghp_abcdefghijklmnopqrstuvwxyz0123456789", "ghp_"],
    ["Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.abcdefghijk", "eyJhbGci"],
    ["password = hunter2hunter2", "hunter2"],
    ["postgres://admin:s3cretpass@db.internal:5432/app", "s3cretpass"],
    ["-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\n-----END PRIVATE KEY-----", "MIIEvQ"],
  ])("removes the sensitive part of: %s", (input, sensitive) => {
    const output = redact(input);
    expect(output).not.toContain(sensitive);
    expect(output).toMatch(/\[(email|number|secret)\]/);
  });

  it.each([
    "I will finish the migration report by Friday.",
    "Meeting on 2026-11-14 at 10:30, budget 2,500 naira, version 16.4.6",
    "Conversation 5f0c7b2e-14d9-4a3e-b8c6-91e2f7a0d435 from 2026",
    "It took 45 minutes and 1200 requests",
  ])("leaves ordinary text alone: %s", (input) => {
    expect(redact(input)).toBe(input);
  });
});

describe("transcript", () => {
  it("labels messages by position and never exposes ids", () => {
    const messages = toPromptMessages([
      stored("uuid-secret-1", "human", "First"),
      stored("uuid-secret-2", "assistant", "Second"),
    ]);
    const text = messages.map(renderMessage).join("\n\n");
    expect(text).toContain("[m1] USER 2026-03-01\nFirst");
    expect(text).toContain("[m2] ASSISTANT 2026-03-01\nSecond");
    expect(text).not.toContain("uuid-secret");
  });

  it("redacts and shortens assistant replies but keeps the user's words", () => {
    const [human, assistant] = toPromptMessages([
      stored("a", "human", `Email me at x@example.com. ${"word ".repeat(1_000)}`),
      stored("b", "assistant", "y".repeat(10_000)),
    ]);
    expect(human!.text).toContain("[email]");
    expect(human!.text.length).toBeGreaterThan(4_000);
    expect(assistant!.text.length).toBeLessThanOrEqual(TRANSCRIPT_LIMITS.assistantChars + 10);
  });

  it("keeps a short conversation in one window", () => {
    const messages = toPromptMessages([stored("a", "human", "Hi"), stored("b", "assistant", "Hello")]);
    expect(windowMessages(messages)).toHaveLength(1);
  });

  it("splits long conversations into overlapping windows, capped, keeping the start and the end", () => {
    const long = Array.from({ length: 120 }, (_, i) => stored(`m${i}`, "human", "word ".repeat(1_500)));
    const windows = windowMessages(toPromptMessages(long));
    expect(windows).toHaveLength(TRANSCRIPT_LIMITS.maxWindows);
    expect(windows[0]![0]!.ordinal).toBe(1);
    expect(windows.at(-1)!.at(-1)!.ordinal).toBe(120);
    for (const window of windows) {
      const size = window.reduce((sum, message) => sum + message.text.length, 0);
      expect(size).toBeLessThanOrEqual(TRANSCRIPT_LIMITS.windowChars);
    }
    // Consecutive tail windows share messages.
    expect(windows[2]!.at(-1)!.ordinal).toBeGreaterThanOrEqual(windows[3]![0]!.ordinal);
  });
});

describe("verifyQuote", () => {
  const messages = toPromptMessages([
    stored("a", "human", "I will finish the migration report by Friday. It’s overdue."),
    stored("b", "assistant", "Here is a plan for the report."),
    stored("c", "human", "Done, I sent it   yesterday."),
  ]);

  it("accepts an exact quote in the named message", () => {
    expect(verifyQuote("I will finish the migration report by Friday.", "m1", messages)).toMatchObject({
      message: { id: "a" },
      refExact: true,
    });
  });

  it("tolerates whitespace, case and curly quotes", () => {
    expect(verifyQuote("it's   OVERDUE", "m1", messages)?.message.id).toBe("a");
    expect(verifyQuote("Done, I sent it yesterday.", "m3", messages)?.message.id).toBe("c");
  });

  it("accepts an elided quote whose parts appear in order", () => {
    expect(verifyQuote("I will finish ... by Friday", "m1", messages)?.message.id).toBe("a");
    expect(verifyQuote("by Friday ... I will finish", "m1", messages)).toBeNull();
  });

  it("finds a quote attributed to the wrong message, and flags it", () => {
    expect(verifyQuote("Here is a plan for the report.", "m1", messages)).toMatchObject({
      message: { id: "b" },
      refExact: false,
    });
  });

  it("rejects quotes that are invented, paraphrased, too short or missing", () => {
    expect(verifyQuote("I promise to finish the report this week", "m1", messages)).toBeNull();
    expect(verifyQuote("I will complete the migration report", "m1", messages)).toBeNull();
    expect(verifyQuote("Done", "m3", messages)).toBeNull();
    expect(verifyQuote(null, "m1", messages)).toBeNull();
    expect(verifyQuote("", "m1", messages)).toBeNull();
  });

  it("rejects a quote that matches several messages when the named one does not", () => {
    const repeated = toPromptMessages([
      stored("a", "human", "Let us continue the work."),
      stored("b", "human", "Let us continue the work."),
      stored("c", "assistant", "Sure."),
    ]);
    expect(verifyQuote("Let us continue the work.", "m3", repeated)).toBeNull();
    expect(verifyQuote("Let us continue the work.", "m2", repeated)?.message.id).toBe("b");
  });

  it("normalises consistently", () => {
    expect(normaliseForMatch("  “Hello” —  World ")).toBe('"hello" - world');
  });
});

describe("discovery rules", () => {
  it("turns only intentions and stronger into tasks", () => {
    expect(["brainstorm", "interest", "uncertain"].map((c) => becomesTask(c as never))).toEqual([false, false, false]);
    expect(["intention", "explicit_commitment", "active_execution"].map((c) => becomesTask(c as never))).toEqual([
      true,
      true,
      true,
    ]);
  });

  it("scores the user's own explicit commitment highest", () => {
    const base = { evidenceRefExact: true, hasVerifiedDueDate: false } as const;
    const explicit = scoreConfidence({ ...base, commitmentClass: "explicit_commitment", evidenceSender: "human" });
    const inferred = scoreConfidence({ ...base, commitmentClass: "explicit_commitment", evidenceSender: "assistant" });
    const intention = scoreConfidence({ ...base, commitmentClass: "intention", evidenceSender: "human" });
    expect(explicit).toBe(0.9);
    expect(explicit).toBeGreaterThan(inferred);
    expect(explicit).toBeGreaterThan(intention);
    expect(scoreConfidence({ commitmentClass: "explicit_commitment", evidenceSender: "human", evidenceRefExact: true, hasVerifiedDueDate: true })).toBe(0.95);
    expect(scoreConfidence({ commitmentClass: "brainstorm", evidenceSender: "assistant", evidenceRefExact: false, hasVerifiedDueDate: false })).toBe(0.05);
  });

  it("compares titles by content words", () => {
    expect(titleSimilarity("Finish the migration report", "Finish migration report!")).toBe(1);
    expect(titleSimilarity("Finish the migration report", "Send the invoice to the client")).toBe(0);
    expect(titleSimilarity("Finish the migration report", "Finish the migration plan")).toBeCloseTo(0.5, 5);
    expect(titleSimilarity("", "anything")).toBe(0);
    expect(dedupeKey("Finish the Report")).toBe(dedupeKey("report: finish"));
  });

  it("keeps valid items and drops malformed ones", () => {
    const good = {
      title: "Finish the report",
      description: "",
      category: "explicit_commitment",
      commitmentClass: "explicit_commitment",
      priority: "high",
      evidenceRef: "m1",
      evidenceQuote: "I will finish the report",
      suggestedNextAction: "",
      dueDate: null,
      dueDateQuote: null,
      completed: false,
      completionRef: null,
      completionQuote: null,
    };
    const { valid, dropped } = keepValid(extractedItemSchema, [
      good,
      { ...good, evidenceRef: "users/bob/tasks/1" },
      { ...good, category: "made_up" },
      { ...good, dueDate: "next Friday" },
      "nonsense",
      null,
    ]);
    expect(valid).toHaveLength(1);
    expect(dropped).toBe(5);
  });
});

describe("AI configuration", () => {
  it("has conservative defaults below the reported free limits", () => {
    expect(parseAIConfig({})).toEqual({
      provider: "gemini",
      bulkModel: "gemini-3.5-flash-lite",
      qualityModel: "gemini-3.8-flash",
      dailyRequestCap: 450,
      requestsPerMinute: 10,
      requestsPerAdvance: 4,
    });
  });

  it("reads overrides and ignores invalid ones", () => {
    const config = parseAIConfig({ AI_DAILY_REQUEST_CAP: "100", AI_REQUESTS_PER_MINUTE: "-3", AI_PROVIDER: "other" });
    expect(config).toMatchObject({ dailyRequestCap: 100, requestsPerMinute: 10, provider: "gemini" });
  });

  it("counts the quota day in Pacific time", () => {
    expect(usageDay(new Date("2026-11-15T05:00:00Z"))).toBe("2026-11-14");
    expect(usageDay(new Date("2026-11-15T09:00:00Z"))).toBe("2026-11-15");
  });
});

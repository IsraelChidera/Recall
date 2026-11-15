import { describe, expect, it } from "vitest";

import type { PromptMessage } from "@/lib/ai/transcript";
import { toTaskView, type TaskView } from "@/lib/discoveries/model";
import type { StoredMessage } from "@/lib/import/plan";
import { buildResumeContext, CONTEXT_LIMITS, CUT_MARKER, excerpt } from "@/lib/resume/context";
import { resumeResponseSchema, toResumeInsights } from "@/lib/resume/insights";
import { buildResumePrompt } from "@/lib/resume/prompt";
import { selectForResume } from "@/lib/resume/select";

const CONVERSATION = { id: "claude_c1", title: "Migration plan", sourceUrl: "https://claude.ai/chat/c1" };

function message(index: number, text?: string): StoredMessage {
  return {
    id: `msg-${index}`,
    sender: index % 2 === 0 ? "human" : "assistant",
    createdAt: `2026-02-0${1 + (index % 9)}T10:00:00.000Z`,
    text: text ?? `Message number ${index}.`,
    truncated: false,
  };
}

function task(overrides: Record<string, unknown> = {}): TaskView {
  return toTaskView("t1", {
    title: "Finish the migration report",
    description: "The report for the platform team.",
    status: "approved",
    suggestedNextAction: "Draft the summary section",
    evidence: [
      {
        kind: "commitment",
        conversationId: "claude_c1",
        messageId: "msg-4",
        messageAt: "2026-02-05T10:00:00.000Z",
        quote: "I will finish the migration report by Friday.",
      },
    ],
    ...overrides,
  });
}

const messages = Array.from({ length: 12 }, (_, index) =>
  message(index, index === 4 ? "I will finish the migration report by Friday." : undefined),
);

describe("buildResumeContext", () => {
  it("takes the messages around the commitment and the end of the conversation, without overlap", () => {
    const context = buildResumeContext({ task: task(), conversation: CONVERSATION, messages, decisions: [] });
    expect(context.around.map((entry) => entry.id)).toEqual(["msg-2", "msg-3", "msg-4", "msg-5", "msg-6"]);
    expect(context.around.filter((entry) => entry.isEvidence).map((entry) => entry.id)).toEqual(["msg-4"]);
    expect(context.ending.map((entry) => entry.id)).toEqual(["msg-8", "msg-9", "msg-10", "msg-11"]);
    expect(context.commitment).toEqual({
      quote: "I will finish the migration report by Friday.",
      saidAt: new Date("2026-02-05T10:00:00.000Z"),
    });
    expect(context.messageCount).toBe(12);
  });

  it("does not repeat messages when the commitment is near the end", () => {
    const short = messages.slice(0, 6);
    const context = buildResumeContext({ task: task(), conversation: CONVERSATION, messages: short, decisions: [] });
    expect(context.around.map((entry) => entry.id)).toEqual(["msg-2", "msg-3", "msg-4", "msg-5"]);
    expect(context.ending).toEqual([]);
  });

  it("falls back to the end of the conversation when the message cannot be found", () => {
    const moved = task({ evidence: [{ kind: "commitment", conversationId: "claude_c1", messageId: "gone", quote: "I will finish it." }] });
    const context = buildResumeContext({ task: moved, conversation: CONVERSATION, messages, decisions: [] });
    expect(context.around).toEqual([]);
    expect(context.ending).toHaveLength(CONTEXT_LIMITS.ending);
    expect(context.commitment?.quote).toBe("I will finish it.");
  });

  it("reports an absent conversation instead of inventing context", () => {
    const context = buildResumeContext({ task: task(), conversation: null, messages: [], decisions: [] });
    expect(context).toMatchObject({ conversation: null, around: [], ending: [], messageCount: 0 });
    expect(context.commitment?.quote).toBe("I will finish the migration report by Friday.");
  });

  it("skips empty messages, shortens long ones visibly and removes secrets", () => {
    const long = "word ".repeat(700);
    const context = buildResumeContext({
      task: task(),
      conversation: CONVERSATION,
      messages: [message(2, long), message(3, "   "), message(4, "I will finish the migration report by Friday. password=hunter2hunter2")],
      decisions: [],
    });
    expect(context.around.map((entry) => entry.id)).toEqual(["msg-2", "msg-4"]);
    expect(context.around[0]!.text).toContain(CUT_MARKER);
    expect(context.around[0]!.text.length).toBeLessThan(CONTEXT_LIMITS.humanChars + 10);
    expect(context.around[1]!.text).not.toContain("hunter2");
  });

  it("keeps only decisions that carry their source words", () => {
    const context = buildResumeContext({
      task: task(),
      conversation: CONVERSATION,
      messages,
      decisions: [
        { text: "Use Postgres", quote: "Let's go with Postgres.", conversationId: "claude_c1" },
        { text: "Unsupported", quote: "", conversationId: "claude_c1" },
      ],
    });
    expect(context.decisions.map((decision) => decision.text)).toEqual(["Use Postgres"]);
  });
});

describe("excerpt", () => {
  it("leaves short text alone and marks a cut in long text", () => {
    expect(excerpt("  short  ", 100)).toBe("short");
    const cut = excerpt(`${"start ".repeat(50)}${"end ".repeat(50)}`, 100);
    expect(cut.startsWith("start")).toBe(true);
    expect(cut.endsWith("end")).toBe(true);
    expect(cut).toContain(CUT_MARKER);
  });
});

describe("buildResumePrompt", () => {
  const context = buildResumeContext({
    task: task({ dueDate: "2026-02-06" }),
    conversation: CONVERSATION,
    messages,
    decisions: [{ text: "Use Postgres", quote: "Let's go with Postgres.", conversationId: "claude_c1" }],
  });

  it("contains the retrieved words and nothing that was not retrieved", () => {
    const prompt = buildResumePrompt(context);
    expect(prompt).toContain("## What I want to finish\nFinish the migration report");
    expect(prompt).toContain('## What I said on 5 February 2026\n"I will finish the migration report by Friday."');
    expect(prompt).toContain("Me (5 February 2026):\nI will finish the migration report by Friday.");
    expect(prompt).toContain("Assistant (4 February 2026):\nMessage number 3.");
    expect(prompt).toContain("## How the conversation ended");
    expect(prompt).toContain('- Use Postgres\n  From: "Let\'s go with Postgres."');
    expect(prompt).toContain("I gave a deadline of 6 February 2026.");
    expect(prompt).toContain("Then help me with the next step: Draft the summary section");
    // No AI section unless verified points are supplied.
    expect(prompt).not.toContain("What had been done");
  });

  it("tells the assistant it lacks the conversation and must not assume", () => {
    const prompt = buildResumePrompt(context);
    expect(prompt).toContain("You do not have that conversation");
    expect(prompt).toContain("ask me instead of assuming");
    expect(prompt).not.toMatch(/as we discussed|you (said|told me|suggested)/i);
  });

  it("states no deadline, decision or next step that was not recorded", () => {
    const bare = buildResumeContext({
      task: task({ dueDate: null, suggestedNextAction: "", description: "" }),
      conversation: CONVERSATION,
      messages,
      decisions: [],
    });
    const prompt = buildResumePrompt(bare);
    expect(prompt).not.toContain("deadline");
    expect(prompt).not.toContain("Decisions");
    expect(prompt).toContain("Then help me work out the next concrete step.");
  });

  it("adds AI points under their own headings, each with its quote and speaker", () => {
    const prompt = buildResumePrompt(context, {
      generatedAt: null,
      points: [
        { kind: "open_question", text: "The summary was not written.", quote: "I still need the summary.", sender: "human" },
        { kind: "progress", text: "An outline existed.", quote: "Here is the outline.", sender: "assistant" },
      ],
    });
    expect(prompt).toContain('## What had been done or worked out\n- An outline existed.\n  From the assistant: "Here is the outline."');
    expect(prompt).toContain('## What was still open\n- The summary was not written.\n  From me: "I still need the summary."');
    expect(prompt.indexOf("What had been done")).toBeLessThan(prompt.indexOf("What was still open"));
  });

  it("says so when the conversation is no longer stored", () => {
    const gone = buildResumeContext({ task: task(), conversation: null, messages: [], decisions: [] });
    const prompt = buildResumePrompt(gone);
    expect(prompt).toContain("no longer stored");
    expect(prompt).toContain('"I will finish the migration report by Friday."');
    expect(prompt).not.toContain("The conversation at that point");
  });
});

describe("selectForResume", () => {
  const prompt = (index: number, chars: number): PromptMessage => ({
    ordinal: index + 1,
    id: `msg-${index}`,
    sender: index % 2 === 0 ? "human" : "assistant",
    createdAt: null,
    text: "x".repeat(chars),
  });

  it("sends a conversation that fits whole", () => {
    const all = Array.from({ length: 10 }, (_, index) => prompt(index, 100));
    expect(selectForResume(all, "msg-3", 60_000)).toBe(all);
  });

  it("keeps the commitment's neighbourhood and the end of a long conversation, in order", () => {
    const all = Array.from({ length: 100 }, (_, index) => prompt(index, 960));
    const chosen = selectForResume(all, "msg-20", 10_000);
    const ids = chosen.map((entry) => entry.ordinal - 1);
    expect(ids).toContain(20);
    expect(ids).toContain(99);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(ids.filter((id) => id >= 17 && id <= 23).length).toBeGreaterThanOrEqual(5);
    expect(ids).not.toContain(50);
    expect(chosen.reduce((sum, entry) => sum + entry.text.length + 40, 0)).toBeLessThanOrEqual(10_000);
  });

  it("uses the end of the conversation when the commitment message is unknown", () => {
    const all = Array.from({ length: 100 }, (_, index) => prompt(index, 960));
    const ids = selectForResume(all, null, 5_000).map((entry) => entry.ordinal - 1);
    expect(ids).toEqual([95, 96, 97, 98, 99]);
  });

  it("still sends one message when a single message exceeds the budget", () => {
    const all = [prompt(0, 50_000), prompt(1, 50_000)];
    expect(selectForResume(all, "msg-0", 10_000).map((entry) => entry.id)).toEqual(["msg-0"]);
  });
});

describe("insights", () => {
  it("reads saved points defensively", () => {
    const insights = toResumeInsights({
      generatedAt: "2026-11-15T10:00:00.000Z",
      points: [
        { kind: "progress", text: " Done. ", quote: "It is done.", sender: "assistant" },
        { kind: "rumour", text: "Unknown kind", quote: "x" },
        { kind: "decision", text: "No quote", quote: "" },
        "nonsense",
      ],
    });
    expect(insights?.points).toEqual([{ kind: "progress", text: "Done.", quote: "It is done.", sender: "assistant" }]);
    expect(insights?.generatedAt?.toISOString()).toBe("2026-11-15T10:00:00.000Z");
    expect(toResumeInsights(undefined)).toBeNull();
    expect(toResumeInsights({})).toEqual({ points: [], generatedAt: null });
  });

  it("accepts an empty model answer and rejects points without a message label", () => {
    expect(resumeResponseSchema.parse({})).toEqual({ progress: [], decisions: [], openQuestions: [] });
    expect(resumeResponseSchema.safeParse({ progress: [{ text: "x", ref: "message 3", quote: "y" }] }).success).toBe(false);
  });
});

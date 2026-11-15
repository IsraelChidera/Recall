import { describe, expect, it } from "vitest";

import {
  activityTypeFor,
  InvalidEditError,
  projectPatch,
  sourceUrlFor,
  taskPatch,
  toProjectView,
  toTaskView,
} from "@/lib/discoveries/model";

describe("toTaskView", () => {
  it("reads a server-written task", () => {
    const at = { toDate: () => new Date("2026-03-01T10:00:00Z") };
    const task = toTaskView("t1", {
      title: "Finish the synthetic report",
      description: "",
      category: "explicit_commitment",
      status: "approved",
      priority: "high",
      confidence: 0.8,
      needsAttention: false,
      completionSuggested: true,
      suggestedNextAction: "Open the draft",
      dueDate: null,
      projectId: "p_1",
      evidence: [
        { kind: "commitment", conversationId: "claude_c1", messageAt: "2026-03-01T10:00:00Z", quote: "I will finish it" },
        { kind: "completion", conversationId: "claude_c1", messageAt: null, quote: "Done" },
      ],
      sourceConversationIds: ["claude_c1"],
      discoveredAt: at,
    });
    expect(task).toMatchObject({ status: "approved", priority: "high", projectId: "p_1", completionSuggested: true });
    expect(task.evidence.map((entry) => entry.kind)).toEqual(["commitment", "completion"]);
    expect(task.evidence[0]!.messageAt?.toISOString()).toBe("2026-03-01T10:00:00.000Z");
    expect(task.discoveredAt?.toISOString()).toBe("2026-03-01T10:00:00.000Z");
  });

  it("falls back to safe values instead of throwing on a malformed document", () => {
    const task = toTaskView("t2", { status: "weird", priority: 7, evidence: "nope", projectId: 3, title: null });
    expect(task).toMatchObject({
      title: "Untitled",
      status: "awaiting_review",
      priority: "medium",
      projectId: null,
      evidence: [],
      confidence: 0,
    });
  });

  it("drops evidence entries that have no quote", () => {
    const task = toTaskView("t3", { evidence: [{ quote: "" }, null, { quote: "kept", conversationId: "claude_x" }] });
    expect(task.evidence).toHaveLength(1);
  });
});

describe("toProjectView", () => {
  it("reads decisions and tolerates missing fields", () => {
    const project = toProjectView("p1", { name: "", decisions: [{ text: "Use Firestore", quote: "let's use Firestore" }, {}] });
    expect(project.name).toBe("Untitled project");
    expect(project.decisions).toEqual([{ text: "Use Firestore", quote: "let's use Firestore", conversationId: "" }]);
    expect(project.archived).toBe(false);
  });
});

describe("sourceUrlFor", () => {
  it("links Claude conversations and nothing else", () => {
    expect(sourceUrlFor("claude_5f0c7b2e-14d9-4a3e-b8c6-91e2f7a0d435")).toBe(
      "https://claude.ai/chat/5f0c7b2e-14d9-4a3e-b8c6-91e2f7a0d435",
    );
    expect(sourceUrlFor("chatgpt_abc")).toBeNull();
    expect(sourceUrlFor("claude_../../evil")).toBeNull();
    expect(sourceUrlFor("")).toBeNull();
  });
});

describe("taskPatch", () => {
  it("produces only fields the security rules let a user change", () => {
    const patch = taskPatch({ title: "  New title ", description: " notes ", priority: "high", projectId: null, status: "approved" });
    expect(patch).toEqual({
      title: "New title",
      description: "notes",
      priority: "high",
      priorityRank: 3,
      projectId: null,
      status: "approved",
    });
  });

  it("keeps priority and its rank together", () => {
    expect(taskPatch({ priority: "low" })).toEqual({ priority: "low", priorityRank: 1 });
  });

  it("explains invalid edits", () => {
    expect(() => taskPatch({ title: "   " })).toThrow(InvalidEditError);
    expect(() => taskPatch({ title: "x".repeat(301) })).toThrow(/300/);
    expect(() => taskPatch({ description: "x".repeat(4001) })).toThrow(/4000/);
    expect(() => taskPatch({ status: "archived" as never })).toThrow(/status/i);
    expect(() => taskPatch({ priority: "urgent" as never })).toThrow(/priority/i);
    expect(() => taskPatch({})).toThrow(/Nothing/);
  });
});

describe("projectPatch", () => {
  it("trims and validates", () => {
    expect(projectPatch({ name: " Recall ", archived: true })).toEqual({ name: "Recall", archived: true });
    expect(() => projectPatch({ name: "" })).toThrow(InvalidEditError);
    expect(() => projectPatch({ description: "x".repeat(2001) })).toThrow(/2000/);
  });
});

describe("activityTypeFor", () => {
  it("names status changes and falls back to an edit", () => {
    expect(activityTypeFor({ status: "approved" })).toBe("task_approved");
    expect(activityTypeFor({ status: "dismissed", title: "x" })).toBe("task_dismissed");
    expect(activityTypeFor({ status: "completed" })).toBe("task_completed");
    expect(activityTypeFor({ status: "awaiting_review" })).toBe("task_edited");
    expect(activityTypeFor({ title: "x" })).toBe("task_edited");
  });
});

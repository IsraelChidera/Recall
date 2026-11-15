import { readFileSync } from "node:fs";

import { initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { collection, doc, getDoc, getDocs, setDoc, type Firestore } from "firebase/firestore";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  editProject,
  listProjects,
  listTasks,
  loadProject,
  loadWorkspace,
  PAGE_SIZE,
  reviewTask,
} from "@/lib/discoveries/store";

/**
 * The review screens' reads and writes, against the emulator with security
 * rules on. Documents are seeded in the shape the server writes them.
 */
const UID = "alice";
let env: RulesTestEnvironment;
let db: Firestore;

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: "demo-recall",
    firestore: { rules: readFileSync("firestore.rules", "utf8") },
  });
  db = env
    .authenticatedContext(UID, { email: "alice@example.com", email_verified: true })
    .firestore() as unknown as Firestore;
});

afterAll(async () => {
  await env.cleanup();
});

beforeEach(async () => {
  await env.clearFirestore();
});

const CONVERSATION = "claude_5f0c7b2e-14d9-4a3e-b8c6-91e2f7a0d435";

function serverTask(overrides: Record<string, unknown> = {}) {
  const now = new Date();
  return {
    title: "Finish the synthetic migration report",
    description: "",
    category: "explicit_commitment",
    commitmentClass: "explicit_commitment",
    status: "awaiting_review",
    priority: "medium",
    priorityRank: 2,
    confidence: 0.85,
    needsAttention: false,
    completionSuggested: false,
    suggestedNextAction: "Open the draft",
    dueDate: null,
    projectId: null,
    remindOn: null,
    lastReviewedAt: null,
    evidence: [
      {
        kind: "commitment",
        conversationId: CONVERSATION,
        messageId: "m1",
        messageAt: "2026-03-01T10:00:00.000Z",
        sender: "human",
        quote: "I will finish the synthetic migration report by Friday.",
      },
    ],
    sourceConversationId: CONVERSATION,
    sourceConversationIds: [CONVERSATION],
    dedupeKey: "finish synthetic migration report",
    originalAt: now,
    lastActivityAt: now,
    discoveredAt: now,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

async function seed(write: (admin: Firestore) => Promise<void>) {
  await env.withSecurityRulesDisabled(async (context) => {
    await write(context.firestore() as unknown as Firestore);
  });
}

const task = async (id: string) => (await getDoc(doc(db, `users/${UID}/tasks/${id}`))).data()!;

describe("reviewing tasks", () => {
  beforeEach(async () => {
    await seed(async (admin) => {
      await setDoc(doc(admin, `users/${UID}/tasks/t1`), serverTask());
      await setDoc(doc(admin, `users/${UID}/projects/p1`), {
        name: "Synthetic migration",
        description: "",
        archived: false,
        conversationIds: [CONVERSATION],
        decisions: [{ text: "Use chunks", conversationId: CONVERSATION, messageId: "m2", quote: "let us use chunks" }],
        lastActivityAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      await setDoc(doc(admin, `users/${UID}/conversations/${CONVERSATION}`), {
        title: "Synthetic conversation",
        sourceUrl: "https://claude.ai/chat/5f0c7b2e-14d9-4a3e-b8c6-91e2f7a0d435",
        updatedAtSource: new Date(),
      });
    });
  });

  it("lists tasks awaiting review with their evidence", async () => {
    const page = await listTasks(db, UID, "awaiting_review");
    expect(page.tasks).toHaveLength(1);
    expect(page.cursor).toBeNull();
    expect(page.tasks[0]).toMatchObject({ id: "t1", status: "awaiting_review", priority: "medium" });
    expect(page.tasks[0]!.evidence[0]!.quote).toContain("synthetic migration report");
  });

  it("approves a task, moving it between lists and logging the decision", async () => {
    await reviewTask(db, UID, "t1", { status: "approved" });
    expect((await listTasks(db, UID, "awaiting_review")).tasks).toHaveLength(0);
    expect((await listTasks(db, UID, "approved")).tasks.map((entry) => entry.id)).toEqual(["t1"]);
    const saved = await task("t1");
    expect(saved.lastReviewedAt.toMillis()).toBeGreaterThan(0);
    const logs = await getDocs(collection(db, `users/${UID}/activityLogs`));
    expect(logs.docs.map((entry) => entry.data().type)).toEqual(["task_approved"]);
  });

  it("dismisses and restores", async () => {
    await reviewTask(db, UID, "t1", { status: "dismissed" });
    expect((await task("t1")).status).toBe("dismissed");
    await reviewTask(db, UID, "t1", { status: "awaiting_review" });
    expect((await task("t1")).status).toBe("awaiting_review");
  });

  it("edits wording, priority and project without touching the evidence", async () => {
    const before = await task("t1");
    await reviewTask(db, UID, "t1", {
      title: "Finish and send the migration report",
      description: "Draft is in the shared folder.",
      priority: "high",
      projectId: "p1",
    });
    const after = await task("t1");
    expect(after).toMatchObject({
      title: "Finish and send the migration report",
      description: "Draft is in the shared folder.",
      priority: "high",
      priorityRank: 3,
      projectId: "p1",
      status: "awaiting_review",
    });
    expect(after.evidence).toEqual(before.evidence);
    expect(after.confidence).toBe(before.confidence);
    expect(after.dedupeKey).toBe(before.dedupeKey);
  });

  it("removes a task from its project", async () => {
    await reviewTask(db, UID, "t1", { projectId: "p1" });
    await reviewTask(db, UID, "t1", { projectId: null });
    expect((await task("t1")).projectId).toBeNull();
  });

  it("marks a task as done", async () => {
    await reviewTask(db, UID, "t1", { status: "completed" });
    expect((await listTasks(db, UID, "completed")).tasks).toHaveLength(1);
  });

  it("refuses an invalid edit before it reaches the server", async () => {
    await expect(reviewTask(db, UID, "t1", { title: "" })).rejects.toThrow(/title/i);
    expect((await task("t1")).title).toBe("Finish the synthetic migration report");
  });

  it("loads a project with its tasks, decisions and conversations, and edits it", async () => {
    await reviewTask(db, UID, "t1", { projectId: "p1" });
    const detail = (await loadProject(db, UID, "p1"))!;
    expect(detail.project).toMatchObject({ name: "Synthetic migration", archived: false });
    expect(detail.project.decisions).toHaveLength(1);
    expect(detail.tasks.map((entry) => entry.id)).toEqual(["t1"]);
    expect(detail.conversations).toEqual([
      expect.objectContaining({ title: "Synthetic conversation", sourceUrl: expect.stringContaining("claude.ai/chat/") }),
    ]);

    await editProject(db, UID, "p1", { name: "Migration report", description: "For the client.", archived: true });
    const [project] = await listProjects(db, UID);
    expect(project).toMatchObject({ name: "Migration report", description: "For the client.", archived: true });
    expect(await loadProject(db, UID, "missing")).toBeNull();
  });

  it("sets and clears a reminder, and tracks work in progress", async () => {
    await reviewTask(db, UID, "t1", { status: "approved" });
    await reviewTask(db, UID, "t1", { status: "in_progress", remindOn: new Date("2026-12-01T12:00:00Z") });
    let saved = await task("t1");
    expect(saved.status).toBe("in_progress");
    expect(saved.remindOn.toDate().toISOString()).toBe("2026-12-01T12:00:00.000Z");

    await reviewTask(db, UID, "t1", { remindOn: null });
    saved = await task("t1");
    expect(saved.remindOn).toBeNull();
    await expect(reviewTask(db, UID, "t1", { remindOn: new Date("not a date") })).rejects.toThrow(/reminder/i);
  });

  it("loads the whole workspace: open and completed tasks and projects, without dismissed ones", async () => {
    await seed(async (admin) => {
      await setDoc(doc(admin, `users/${UID}/tasks/t2`), serverTask({ status: "completed" }));
      await setDoc(doc(admin, `users/${UID}/tasks/t3`), serverTask({ status: "dismissed" }));
      await setDoc(doc(admin, `users/${UID}/tasks/t4`), serverTask({ status: "in_progress" }));
    });
    const workspace = await loadWorkspace(db, UID);
    expect(workspace.tasks.map((entry) => entry.id).sort()).toEqual(["t1", "t2", "t4"]);
    expect(workspace.tasks.find((entry) => entry.id === "t1")).toMatchObject({
      commitmentClass: "explicit_commitment",
      remindOn: null,
    });
    expect(workspace.projects.map((entry) => entry.id)).toEqual(["p1"]);
    await expect(loadWorkspace(db, "bob")).rejects.toThrow();
  });

  it("cannot be used on another user's task", async () => {
    await expect(reviewTask(db, "bob", "t1", { status: "approved" })).rejects.toThrow();
    await expect(listTasks(db, "bob", "awaiting_review")).rejects.toThrow();
  });
});

describe("pagination", () => {
  it("pages through more tasks than fit on one page, newest first, without repeats", async () => {
    const total = PAGE_SIZE + 7;
    await seed(async (admin) => {
      for (let i = 0; i < total; i++) {
        await setDoc(
          doc(admin, `users/${UID}/tasks/t${String(i).padStart(3, "0")}`),
          serverTask({ title: `Synthetic task ${i}`, discoveredAt: new Date(Date.UTC(2026, 0, 1, 0, i)) }),
        );
      }
    });
    const first = await listTasks(db, UID, "awaiting_review");
    expect(first.tasks).toHaveLength(PAGE_SIZE);
    expect(first.tasks[0]!.title).toBe(`Synthetic task ${total - 1}`);
    expect(first.cursor).not.toBeNull();

    const second = await listTasks(db, UID, "awaiting_review", first.cursor);
    expect(second.tasks).toHaveLength(7);
    expect(second.cursor).toBeNull();
    const ids = new Set([...first.tasks, ...second.tasks].map((entry) => entry.id));
    expect(ids.size).toBe(total);
  });
});

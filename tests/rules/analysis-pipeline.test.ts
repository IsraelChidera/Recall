import { readFileSync } from "node:fs";

import { initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { deleteApp, initializeApp, type App } from "firebase-admin/app";
import { getFirestore, Timestamp, type Firestore as AdminFirestore } from "firebase-admin/firestore";
import type { Firestore } from "firebase/firestore";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { usageDay, type AIConfig } from "@/lib/ai/config";
import { FakeProvider } from "@/lib/ai/fake";
import { EXTRACTION_SYSTEM, RESUME_SYSTEM, SCREENING_SYSTEM } from "@/lib/ai/prompts";
import {
  AIRateLimitError,
  AIResponseError,
  AIUnavailableError,
  type AIProvider,
  type StructuredRequest,
  type StructuredResponse,
} from "@/lib/ai/provider";
import type { NormalisedConversation } from "@/lib/domain/conversation";
import { deleteImport, deleteSourceData, FirestoreImportWriter, listImports, loadSourceIndex } from "@/lib/import/firestore-writer";
import { parseExport } from "@/lib/import/parse-export";
import { planImport } from "@/lib/import/plan";
import { loadResume } from "@/lib/discoveries/store";
import { buildResumePrompt } from "@/lib/resume/prompt";
import { advanceJob, JobError, startJob } from "@/lib/server/analysis/job";
import { generateResumeInsights } from "@/lib/server/resume/generate";
import type { AnalysisDeps, JobView } from "@/lib/server/analysis/types";

import {
  asFile,
  makeConversation,
  makeConversations,
  makeExportZip,
  type SyntheticConversation,
} from "../fixtures/claude-export";

/**
 * The analysis pipeline end to end on the Firestore emulator: conversations
 * are saved through the real import writer (under security rules), then
 * analysed through the real job runner (Admin SDK) with a stand-in model.
 */
const UID = "alice";
const PROJECT = "demo-recall";
let env: RulesTestEnvironment;
let clientDb: Firestore;
let adminApp: App;
let db: AdminFirestore;

const config: AIConfig = {
  provider: "fake",
  bulkModel: "fake",
  qualityModel: "fake",
  dailyRequestCap: 450,
  userDailyRequestCap: 450,
  requestsPerMinute: 10,
  requestsPerAdvance: 4,
};

/**
 * Dependencies with a controllable clock: sleeping, and waiting between calls,
 * moves time forward instantly, so pacing and backoff run without real delays.
 */
type TestDeps = AnalysisDeps & { advance: (ms: number) => void };

function deps(provider: AIProvider, overrides: Partial<AIConfig> = {}): TestDeps {
  let offset = 0;
  return {
    db,
    provider,
    config: { ...config, ...overrides },
    now: () => new Date(Date.now() + offset),
    sleep: async (ms) => {
      offset += ms;
    },
    advance: (ms) => {
      offset += ms;
    },
  };
}

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: PROJECT,
    firestore: { rules: readFileSync("firestore.rules", "utf8") },
  });
  clientDb = env
    .authenticatedContext(UID, { email: "alice@example.com", email_verified: true })
    .firestore() as unknown as Firestore;
  adminApp = initializeApp({ projectId: PROJECT }, "analysis-pipeline-test");
  db = getFirestore(adminApp);
});

afterAll(async () => {
  await deleteApp(adminApp);
  await env.cleanup();
});

beforeEach(async () => {
  await env.clearFirestore();
});

/** Saves conversations exactly as the Import page does. */
async function importConversations(raw: unknown[]): Promise<NormalisedConversation[]> {
  const conversations: NormalisedConversation[] = [];
  const result = await parseExport([asFile("conversations-000.zip", await makeExportZip(raw))], {
    onConversation: (conversation) => {
      conversations.push(conversation);
    },
  });
  const index = await loadSourceIndex(clientDb, UID, "claude");
  const plan = planImport(conversations, index);
  if (plan.new + plan.updated === 0) return conversations;
  const writer = new FirestoreImportWriter(clientDb, UID, {
    sourceId: "claude",
    adapterVersion: 1,
    importId: result.fingerprint,
    fileNames: ["conversations-000.zip"],
    plan,
    issues: result.issues,
    index,
  });
  await writer.begin();
  for (let start = 0; start < conversations.length; start += 20) {
    await writer.writeBatch(conversations.slice(start, start + 20));
  }
  await writer.finish();
  return conversations;
}

async function giveConsent(): Promise<void> {
  await db.doc(`users/${UID}`).set(
    { aiConsentAccepted: true, aiConsentVersion: 1, createdAt: Timestamp.now(), updatedAt: Timestamp.now() },
    { merge: true },
  );
}

/** Drives a job the way the browser does, until it stops running. */
async function runJob(dependencies: TestDeps, maxCalls = 200): Promise<JobView> {
  let view = await startJob(dependencies, UID);
  for (let call = 0; call < maxCalls && view.status === "running"; call++) {
    view = await advanceJob(dependencies, UID, view.id, true);
    dependencies.advance(view.waitMs);
  }
  return view;
}

const tasks = async () => (await db.collection(`users/${UID}/tasks`).get()).docs.map((entry) => ({ id: entry.id, ...entry.data() })) as Array<Record<string, unknown> & { id: string }>;

function setFirstMessage(conversation: SyntheticConversation, text: string): SyntheticConversation {
  const first = conversation.chat_messages[0]!;
  first.text = text;
  (first.content as { text: string }[]).at(-1)!.text = text;
  return conversation;
}

/** A commitment conversation with its own wording, so it is not merged with others. */
function commitment(index: number, text: string): SyntheticConversation {
  return setFirstMessage(makeConversation(index, { planted: "commitment", turns: 3 }), text);
}

/** A model whose answers the test controls. Returning an Error throws it. */
class ScriptedProvider implements AIProvider {
  readonly name = "scripted";
  readonly requests: StructuredRequest<unknown>[] = [];
  constructor(
    private readonly answer: (request: StructuredRequest<unknown>, call: number) => unknown | Promise<unknown>,
  ) {}
  async generateStructured<T>(request: StructuredRequest<T>): Promise<StructuredResponse<T>> {
    this.requests.push(request);
    const raw = await this.answer(request, this.requests.length);
    if (raw instanceof Error) throw raw;
    const parsed = request.schema.safeParse(raw);
    if (!parsed.success) throw new AIResponseError("scripted answer did not match");
    return { data: parsed.data, model: "scripted", usage: { inputTokens: 10, outputTokens: 5 } };
  }
}

const viaFake = (request: StructuredRequest<unknown>) =>
  new FakeProvider().generateStructured(request).then((response) => response.data);

const keepAll = (request: StructuredRequest<unknown>) => ({
  results: [...request.prompt.matchAll(/### Conversation (\d+)/g)].map((match) => ({
    n: Number(match[1]),
    keep: true,
    reason: "kept",
  })),
});

const item = (overrides: Record<string, unknown>) => ({
  title: "Finish the synthetic migration report",
  description: "",
  category: "explicit_commitment",
  commitmentClass: "explicit_commitment",
  priority: "high",
  evidenceRef: "m1",
  evidenceQuote: "I will finish the synthetic migration report by Friday.",
  suggestedNextAction: "Open the draft",
  dueDate: null,
  dueDateQuote: null,
  completed: false,
  completionRef: null,
  completionQuote: null,
  ...overrides,
});

describe("guards", () => {
  it("refuses to start without consent", async () => {
    await importConversations(makeConversations(4));
    await expect(startJob(deps(new FakeProvider()), UID)).rejects.toMatchObject({ status: 403 });
    expect(await tasks()).toHaveLength(0);
  });

  it("refuses an account that is not allowed to use AI, and unknown jobs", async () => {
    await giveConsent();
    const view = await startJob(deps(new FakeProvider()), UID);
    await expect(advanceJob(deps(new FakeProvider()), UID, view.id, false)).rejects.toBeInstanceOf(JobError);
    await expect(advanceJob(deps(new FakeProvider()), UID, "missing", true)).rejects.toMatchObject({ status: 404 });
  });
});

describe("a full run", () => {
  it("discovers commitments with verifiable evidence and ignores brainstorms", async () => {
    await giveConsent();
    const imported = await importConversations(makeConversations(40));
    const provider = new FakeProvider();
    const view = await runJob(deps(provider));

    expect(view.status).toBe("completed");
    expect(view.progress.screened).toBe(40);
    expect(view.progress.shortlisted).toBe(20);
    expect(view.progress.analysed).toBe(20);
    expect(view.progress.failed).toBe(0);

    const found = await tasks();
    const open = found.filter((task) => task.status === "awaiting_review");
    const completed = found.filter((task) => task.status === "completed");

    // Ten conversations state the same commitment: merged into one task.
    expect(open).toHaveLength(1);
    expect(view.progress.tasksMerged).toBe(9);
    expect((open[0]!.sourceConversationIds as string[]).length).toBe(10);
    expect(open[0]).toMatchObject({ commitmentClass: "explicit_commitment", priorityRank: 3, needsAttention: false });

    // Ten were finished later in the same conversation.
    expect(completed).toHaveLength(10);
    for (const task of completed) {
      const kinds = (task.evidence as { kind: string }[]).map((evidence) => evidence.kind);
      expect(kinds).toEqual(["commitment", "completion"]);
    }

    // Independent check: every stored quote is in the message it points at.
    const byId = new Map(imported.map((conversation) => [conversation.id, conversation]));
    for (const task of found) {
      for (const evidence of task.evidence as { conversationId: string; messageId: string; quote: string }[]) {
        const message = byId.get(evidence.conversationId)!.messages.find((entry) => entry.id === evidence.messageId);
        expect(message, `message for ${task.title as string}`).toBeDefined();
        expect(message!.text).toContain(evidence.quote);
      }
      expect(task.dueDate).toBeNull();
    }

    // Brainstorm and trivial conversations produced nothing.
    const sources = new Set(found.flatMap((task) => task.sourceConversationIds as string[]));
    for (const conversation of imported) {
      const brainstorm = conversation.messages[0]?.text.includes("thinking out loud");
      if (brainstorm) expect(sources.has(conversation.id)).toBe(false);
    }

    // Every conversation has a final analysis state and is off the queue.
    const conversations = await db.collection(`users/${UID}/conversations`).get();
    const states = conversations.docs.map((entry) => (entry.data().analysis as { state: string }).state);
    expect(states.filter((state) => state === "analysed")).toHaveLength(20);
    expect(states.every((state) => ["analysed", "screened_out", "skipped_trivial"].includes(state))).toBe(true);
    expect(conversations.docs.every((entry) => entry.data().needsAnalysis === false)).toBe(true);

    // The usage counter matches the requests actually made.
    expect(view.usage.aiRequests).toBe(provider.requests.length);
    expect(view.progress.aiRequests).toBe(provider.requests.length);
    expect(provider.requests.filter((request) => request.system === SCREENING_SYSTEM)).toHaveLength(2);

    // A project was recorded for the work.
    expect((await db.collection(`users/${UID}/projects`).get()).size).toBe(1);
  });

  it("makes no further requests when nothing has changed", async () => {
    await giveConsent();
    await importConversations(makeConversations(12));
    await runJob(deps(new FakeProvider()));
    const before = await tasks();

    const second = new FakeProvider();
    const view = await runJob(deps(second));
    expect(view.status).toBe("completed");
    expect(second.requests).toHaveLength(0);
    expect(await tasks()).toEqual(before);
  });
});

describe("privacy", () => {
  it("never sends excluded conversations, and redacts what it does send", async () => {
    await giveConsent();
    const excluded = commitment(1, "I will renew the SECRETPROJECT licence before March.");
    const kept = commitment(2, "I will email the supplier at jane@example.com about the delayed order.");
    await importConversations([excluded, kept]);
    await db.doc(`users/${UID}/conversations/claude_${excluded.uuid}`).update({ excluded: true });

    const provider = new FakeProvider();
    const view = await runJob(deps(provider));
    expect(view.status).toBe("completed");

    const sent = provider.requests.map((request) => request.prompt).join("\n");
    expect(sent).not.toContain("SECRETPROJECT");
    expect(sent).not.toContain("jane@example.com");
    expect(sent).toContain("[email]");
    expect(sent).not.toContain(kept.uuid);

    const found = await tasks();
    expect(found).toHaveLength(1);
    expect(found[0]!.sourceConversationId).toBe(`claude_${kept.uuid}`);
    const state = (await db.doc(`users/${UID}/conversations/claude_${excluded.uuid}`).get()).data()!.analysis.state;
    expect(state).toBe("excluded");
  });
});

describe("an untrustworthy model", () => {
  it("stores nothing whose quote is not in the conversation", async () => {
    await giveConsent();
    await importConversations([commitment(1, "I will finish the synthetic migration report by Friday.")]);
    const provider = new ScriptedProvider((request) =>
      request.system === SCREENING_SYSTEM
        ? keepAll(request)
        : {
            project: { name: "Invented", description: "" },
            items: [
              item({ title: "Invented task", evidenceQuote: "I promise to rebuild the entire platform" }),
              item({ title: "Paraphrased task", evidenceQuote: "I will complete the migration report" }),
              item({ title: "Bad reference", evidenceRef: "users/bob/tasks/1" }),
              item({ title: "Idle thought", commitmentClass: "brainstorm" }),
            ],
            decisions: [{ text: "Use Postgres", ref: "m1", quote: "we decided to use Postgres for everything" }],
            existingTasks: [],
          },
    );
    const view = await runJob(deps(provider));
    expect(view.status).toBe("completed");
    expect(await tasks()).toHaveLength(0);
    expect(view.progress.discarded).toBe(4);
    expect((await db.collection(`users/${UID}/projects`).get()).size).toBe(0);
  });

  it("drops invented deadlines and completions but keeps the verified task", async () => {
    await giveConsent();
    await importConversations([commitment(1, "I will finish the synthetic migration report by Friday.")]);
    const provider = new ScriptedProvider((request) =>
      request.system === SCREENING_SYSTEM
        ? keepAll(request)
        : {
            project: null,
            items: [
              item({
                dueDate: "2026-12-25",
                dueDateQuote: "due on Christmas day",
                completed: true,
                completionRef: "m1",
                completionQuote: "I will finish the synthetic migration report by Friday.",
              }),
            ],
            decisions: [],
            existingTasks: [],
          },
    );
    await runJob(deps(provider));
    const [task] = await tasks();
    // The due date had no real quote; the "completion" was the commitment itself.
    expect(task).toMatchObject({ status: "awaiting_review", dueDate: null });
    expect((task!.evidence as unknown[]).length).toBe(1);
  });

  it("keeps every conversation when the screening answer is unusable", async () => {
    await giveConsent();
    await importConversations([commitment(1, "I will finish the synthetic migration report by Friday.")]);
    const provider = new ScriptedProvider((request) =>
      request.system === SCREENING_SYSTEM ? { nonsense: true } : { project: null, items: [item({})], decisions: [], existingTasks: [] },
    );
    const view = await runJob(deps(provider));
    expect(view.progress.shortlisted).toBe(1);
    expect(await tasks()).toHaveLength(1);
  });

  it("gives up on a conversation after two unusable answers without stopping the job", async () => {
    await giveConsent();
    await importConversations([
      commitment(1, "I will finish the synthetic migration report by Friday."),
      commitment(2, "I will book the venue for the offsite next month."),
    ]);
    let extractions = 0;
    const provider = new ScriptedProvider((request) => {
      if (request.system === SCREENING_SYSTEM) return keepAll(request);
      extractions++;
      return request.prompt.includes("migration report") ? "not an object" : viaFake(request);
    });
    const view = await runJob(deps(provider));
    expect(view.status).toBe("completed");
    expect(view.progress.failed).toBe(1);
    expect(view.progress.analysed).toBe(1);
    expect(extractions).toBe(3);
    expect((await tasks()).map((task) => String(task.title))).toEqual(["Book the venue for the offsite next month"]);
  });
});

describe("quota, failures and resuming", () => {
  it("pauses at the daily cap and resumes without duplicating work", async () => {
    await giveConsent();
    const promises = [
      "I will translate the onboarding handbook into Yoruba.",
      "I will repaint the kitchen cupboards green.",
      "I will benchmark three vector databases for search.",
      "I will renew my passport before July.",
      "I will record a podcast pilot about football tactics.",
      "I will migrate the newsletter archive to markdown.",
      "I will plant tomatoes along the back fence.",
      "I will audit accessibility on the checkout flow.",
    ];
    await importConversations(promises.map((text, i) => commitment(i + 1, text)));
    const first = new FakeProvider();
    const paused = await runJob(deps(first, { userDailyRequestCap: 4 }));
    expect(paused.status).toBe("paused_quota");
    expect(paused.message).toMatch(/allowance|limit/i);
    expect(first.requests).toHaveLength(4);
    expect(paused.usage.aiRequests).toBe(4);
    const partial = (await tasks()).length;
    expect(partial).toBe(3);

    // Calling again while paused does nothing.
    const still = await advanceJob(deps(first, { userDailyRequestCap: 4 }), UID, paused.id, true);
    expect(still.status).toBe("paused_quota");
    expect(first.requests).toHaveLength(4);

    // The next day (a higher cap here) the same job continues.
    const second = new FakeProvider();
    const resumed = await runJob(deps(second, { userDailyRequestCap: 100 }));
    expect(resumed.id).toBe(paused.id);
    expect(resumed.status).toBe("completed");
    expect(resumed.progress.analysed).toBe(8);
    expect(await tasks()).toHaveLength(8);
    expect(second.requests.filter((request) => request.system === EXTRACTION_SYSTEM)).toHaveLength(5);
  });

  it("holds each user to their own limit while the shared total is counted for everyone", async () => {
    await giveConsent();
    await importConversations(
      [
        "I will translate the onboarding handbook into Yoruba.",
        "I will repaint the kitchen cupboards green.",
        "I will benchmark three vector databases for search.",
      ].map((text, i) => commitment(i + 1, text)),
    );
    const provider = new FakeProvider();
    const paused = await runJob(deps(provider, { userDailyRequestCap: 2 }));
    expect(paused.status).toBe("paused_quota");
    expect(paused.message).toMatch(/your AI allowance/);
    expect(paused.usage).toMatchObject({ aiRequests: 2, dailyCap: 2 });

    const day = usageDay(new Date());
    expect((await db.doc(`users/${UID}/usage/${day}`).get()).data()?.aiRequests).toBe(2);
    expect((await db.doc(`usage/${day}`).get()).data()?.aiRequests).toBe(2);
  });

  it("stops everyone when the shared daily total is reached, whatever their own limit", async () => {
    await giveConsent();
    await importConversations([commitment(1, "I will translate the onboarding handbook into Yoruba.")]);
    // Other users have already used the whole shared allowance today.
    await db.doc(`usage/${usageDay(new Date())}`).set({ aiRequests: 10 });

    const provider = new FakeProvider();
    const paused = await runJob(deps(provider, { dailyRequestCap: 10, userDailyRequestCap: 5 }));
    expect(paused.status).toBe("paused_quota");
    expect(paused.message).toMatch(/shared AI allowance/);
    expect(provider.requests).toHaveLength(0);
    expect(paused.usage.aiRequests).toBe(0);
    expect(await tasks()).toHaveLength(0);
  });

  it("leaves a user only what remains of the shared total", async () => {
    await giveConsent();
    await importConversations(
      ["I will repaint the kitchen cupboards green.", "I will renew my passport before July."].map(
        (text, i) => commitment(i + 1, text),
      ),
    );
    await db.doc(`usage/${usageDay(new Date())}`).set({ aiRequests: 8 });
    const provider = new FakeProvider();
    const paused = await runJob(deps(provider, { dailyRequestCap: 10, userDailyRequestCap: 100 }));
    expect(provider.requests).toHaveLength(2);
    expect(paused.status).toBe("paused_quota");
    expect(paused.message).toMatch(/shared AI allowance/);
    expect((await db.doc(`usage/${usageDay(new Date())}`).get()).data()?.aiRequests).toBe(10);
  });

  it("stops when the provider reports its own daily quota", async () => {
    await giveConsent();
    await importConversations([commitment(1, "I will finish the synthetic migration report by Friday.")]);
    const provider = new ScriptedProvider(() => new AIRateLimitError(true, null));
    const view = await runJob(deps(provider));
    expect(view.status).toBe("paused_quota");
    expect(view.usage.aiRequests).toBe(0);
  });

  it("waits out a per-minute limit and then continues", async () => {
    await giveConsent();
    await importConversations([commitment(1, "I will finish the synthetic migration report by Friday.")]);
    let limited = true;
    const provider = new ScriptedProvider((request) => {
      if (limited) {
        limited = false;
        return new AIRateLimitError(false, 2_000);
      }
      return viaFake(request);
    });
    const dependencies = deps(provider);
    const started = await startJob(dependencies, UID);
    const first = await advanceJob(dependencies, UID, started.id, true);
    expect(first.status).toBe("running");
    expect(first.waitMs).toBe(2_000);
    dependencies.advance(first.waitMs);
    const view = await runJob(dependencies);
    expect(view.status).toBe("completed");
    expect(await tasks()).toHaveLength(1);
  });

  it("pauses after repeated provider failures", async () => {
    await giveConsent();
    await importConversations([commitment(1, "I will finish the synthetic migration report by Friday.")]);
    const provider = new ScriptedProvider(() => new AIUnavailableError("HTTP 503"));
    const view = await runJob(deps(provider));
    expect(view.status).toBe("paused_error");
    expect(provider.requests).toHaveLength(5);
  });

  it("lets only one caller work on a job at a time", async () => {
    await giveConsent();
    await importConversations([commitment(1, "I will finish the synthetic migration report by Friday.")]);
    const provider = new FakeProvider();
    const started = await startJob(deps(provider), UID);
    await db.doc(`users/${UID}/jobs/${started.id}`).update({ leaseUntil: Timestamp.fromMillis(Date.now() + 60_000) });
    const blocked = await advanceJob(deps(provider), UID, started.id, true);
    expect(blocked.waitMs).toBe(3_000);
    expect(provider.requests).toHaveLength(0);

    // An expired lease (a call that died) does not block the job.
    await db.doc(`users/${UID}/jobs/${started.id}`).update({ leaseUntil: Timestamp.fromMillis(Date.now() - 1) });
    expect((await runJob(deps(provider))).status).toBe("completed");
  });
});

describe("re-analysis after a newer export", () => {
  it("respects the user's decisions and detects completion", async () => {
    await giveConsent();
    const keepOpen = setFirstMessage(makeConversation(1, { planted: "commitment", turns: 3 }), "I will draft the synthetic grant proposal for the foundation.");
    const toDismiss = setFirstMessage(makeConversation(2, { planted: "commitment", turns: 3 }), "I will reorganise the synthetic photo archive this winter.");
    await importConversations([keepOpen, toDismiss]);
    await runJob(deps(new FakeProvider()));

    const before = await tasks();
    expect(before).toHaveLength(2);
    const approved = before.find((task) => String(task.title).includes("grant proposal"))!;
    const dismissed = before.find((task) => String(task.title).includes("photo archive"))!;
    await db.doc(`users/${UID}/tasks/${approved.id}`).update({ status: "approved", title: "My own wording" });
    await db.doc(`users/${UID}/tasks/${dismissed.id}`).update({ status: "dismissed" });

    // A newer export: both conversations gained turns; the first now says it is done.
    const finished = setFirstMessage(makeConversation(1, { planted: "commitment", turns: 5 }), "I will draft the synthetic grant proposal for the foundation.");
    const last = finished.chat_messages.at(-2)!;
    const doneText = "Done, I submitted the synthetic grant proposal this morning.";
    last.text = doneText;
    (last.content as { text: string }[]).at(-1)!.text = doneText;
    const longer = setFirstMessage(makeConversation(2, { planted: "commitment", turns: 5 }), "I will reorganise the synthetic photo archive this winter.");
    await importConversations([finished, longer]);

    const view = await runJob(deps(new FakeProvider()));
    expect(view.status).toBe("completed");
    expect(view.progress.analysed).toBe(2);

    const after = await tasks();
    expect(after).toHaveLength(2);
    const approvedAfter = after.find((task) => task.id === approved.id)!;
    // Still the user's task, with their wording; completion is offered, not applied.
    expect(approvedAfter).toMatchObject({ status: "approved", title: "My own wording", completionSuggested: true });
    expect((approvedAfter.evidence as { kind: string }[]).some((evidence) => evidence.kind === "completion")).toBe(true);
    // A dismissed task stays dismissed and is not recreated.
    expect(after.find((task) => task.id === dismissed.id)).toMatchObject({ status: "dismissed" });
  });
});

describe("deleting imported data", () => {
  it("removes discoveries that quote a deleted conversation and rediscovers what remains", async () => {
    await giveConsent();
    const sentence = "I will publish the synthetic design tokens package.";
    await importConversations([commitment(1, sentence)]);
    await importConversations([commitment(1, sentence), commitment(2, sentence)]);
    await runJob(deps(new FakeProvider()));

    // The same commitment in two conversations: one merged task citing both.
    const merged = await tasks();
    expect(merged).toHaveLength(1);
    expect((merged[0]!.sourceConversationIds as string[]).length).toBe(2);

    // Delete the second import, which holds only the second conversation.
    const [latest] = await listImports(clientDb, UID);
    expect(await deleteImport(clientDb, UID, { id: latest!.id }, "claude")).toBe(1);
    expect(await tasks()).toHaveLength(0);

    // The surviving conversation is queued again and its task comes back,
    // now citing only what still exists.
    const view = await runJob(deps(new FakeProvider()));
    expect(view.status).toBe("completed");
    const again = await tasks();
    expect(again).toHaveLength(1);
    expect(again[0]!.sourceConversationIds).toHaveLength(1);
    const quotes = (again[0]!.evidence as { conversationId: string }[]).map((evidence) => evidence.conversationId);
    expect(new Set(quotes).size).toBe(1);
  });

  it("removes every task and project when all imported data is deleted", async () => {
    await giveConsent();
    await importConversations(makeConversations(12));
    await runJob(deps(new FakeProvider()));
    expect((await tasks()).length).toBeGreaterThan(0);

    await deleteSourceData(clientDb, UID, "claude");
    expect(await tasks()).toHaveLength(0);
    expect((await db.collection(`users/${UID}/projects`).get()).size).toBe(0);
    expect((await db.collection(`users/${UID}/conversations`).get()).size).toBe(0);
  });
});

describe("resuming a task", () => {
  const TEXT = "I will send the quarterly figures to jane@example.com before the board meeting.";

  async function discovered(): Promise<string> {
    await giveConsent();
    await importConversations([commitment(1, TEXT)]);
    await runJob(deps(new FakeProvider()));
    const [task] = await tasks();
    return task!.id;
  }
  const usedToday = async () =>
    ((await db.doc(`users/${UID}/usage/${usageDay(new Date())}`).get()).data()?.aiRequests as number) ?? 0;

  it("retrieves the real conversation around the commitment and builds a prompt from it", async () => {
    const taskId = await discovered();
    const resume = (await loadResume(clientDb, UID, taskId))!;

    expect(resume.context.conversation?.sourceUrl).toMatch(/^https:\/\/claude\.ai\/chat\//);
    expect(resume.context.messageCount).toBe(6);
    const evidence = resume.context.around.find((message) => message.isEvidence)!;
    expect(evidence.sender).toBe("human");
    // The address is replaced before the text can be pasted anywhere.
    expect(evidence.text).toBe("I will send the quarterly figures to [email] before the board meeting.");
    expect(resume.insights).toBeNull();

    const prompt = buildResumePrompt(resume.context, resume.insights);
    expect(prompt).toContain("I will send the quarterly figures to [email] before the board meeting.");
    expect(prompt).toContain("Synthetic answer 1.");
    expect(prompt).not.toContain("jane@example.com");
    expect(prompt).toContain("You do not have that conversation");
  });

  it("adds only points whose quotes are in the conversation, with one counted request", async () => {
    const taskId = await discovered();
    const before = await usedToday();
    const provider = new FakeProvider();
    const result = await generateResumeInsights(deps(provider), UID, taskId);

    // The stand-in also returns a point with an invented quote. It is dropped.
    expect(result.points.map((point) => point.kind)).toEqual(["progress", "open_question"]);
    expect(result.points.map((point) => point.text)).not.toContain("A final version had been delivered.");
    expect(result.points[1]).toMatchObject({ sender: "human", quote: TEXT.replace("jane@example.com", "[email]") });

    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]).toMatchObject({ role: "quality", system: RESUME_SYSTEM });
    expect(provider.requests[0]!.prompt).not.toContain("jane@example.com");
    expect(await usedToday()).toBe(before + 1);

    // Saved on the task, read back under the rules and placed in the prompt.
    const resume = (await loadResume(clientDb, UID, taskId))!;
    expect(resume.insights?.points).toHaveLength(2);
    expect(buildResumePrompt(resume.context, resume.insights)).toContain("## What was still open");
    // The user can still review the task: the saved points do not block their edits.
    const { reviewTask } = await import("@/lib/discoveries/store");
    await reviewTask(clientDb, UID, taskId, { status: "approved" });
  });

  it("refuses without consent, for unknown tasks and for conversations left out", async () => {
    const taskId = await discovered();
    const provider = new FakeProvider();
    await expect(generateResumeInsights(deps(provider), UID, "missing")).rejects.toMatchObject({ status: 404 });
    // Another user's id reaches nothing: paths are built from the caller's uid.
    await db.doc("users/bob").set({ aiConsentAccepted: true, aiConsentVersion: 1 });
    await expect(generateResumeInsights(deps(provider), "bob", taskId)).rejects.toMatchObject({ status: 404 });

    const [conversation] = (await db.collection(`users/${UID}/conversations`).get()).docs;
    await conversation!.ref.update({ excluded: true });
    await expect(generateResumeInsights(deps(provider), UID, taskId)).rejects.toMatchObject({ status: 409 });
    await conversation!.ref.update({ excluded: false });

    await db.doc(`users/${UID}`).update({ aiConsentAccepted: false });
    await expect(generateResumeInsights(deps(provider), UID, taskId)).rejects.toMatchObject({ status: 403 });
    expect(provider.requests).toHaveLength(0);
  });

  it("makes no request once a daily limit is reached", async () => {
    const taskId = await discovered();
    const provider = new FakeProvider();
    const used = await usedToday();
    await expect(
      generateResumeInsights(deps(provider, { userDailyRequestCap: used }), UID, taskId),
    ).rejects.toMatchObject({ status: 429, message: expect.stringMatching(/your AI allowance/) });
    await expect(
      generateResumeInsights(deps(provider, { dailyRequestCap: used }), UID, taskId),
    ).rejects.toMatchObject({ status: 429, message: expect.stringMatching(/shared AI allowance/) });
    expect(provider.requests).toHaveLength(0);
  });

  it("reports provider failures without saving anything, and counts an unusable answer", async () => {
    const taskId = await discovered();
    const before = await usedToday();
    await expect(
      generateResumeInsights(deps(new ScriptedProvider(() => new AIUnavailableError("down"))), UID, taskId),
    ).rejects.toMatchObject({ status: 503 });
    await expect(
      generateResumeInsights(deps(new ScriptedProvider(() => new AIRateLimitError(false, 1_000))), UID, taskId),
    ).rejects.toMatchObject({ status: 429 });
    expect(await usedToday()).toBe(before);

    await expect(
      generateResumeInsights(deps(new ScriptedProvider(() => ({ progress: "not a list" }))), UID, taskId),
    ).rejects.toMatchObject({ status: 502 });
    expect(await usedToday()).toBe(before + 1);
    expect((await db.doc(`users/${UID}/tasks/${taskId}`).get()).data()?.resume).toBeUndefined();
  });

  it("does not let another user read the context", async () => {
    const taskId = await discovered();
    const bob = env
      .authenticatedContext("bob", { email: "bob@example.com", email_verified: true })
      .firestore() as unknown as Firestore;
    await expect(loadResume(bob, UID, taskId)).rejects.toThrow();
  });
});

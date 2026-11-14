import "server-only";

import { FieldValue, Timestamp, type DocumentSnapshot } from "firebase-admin/firestore";

import { usageDay } from "@/lib/ai/config";
import {
  EXTRACTION_SYSTEM,
  extractionPrompt,
  RECONCILIATION_SYSTEM,
  reconciliationPrompt,
  SCREENING_SYSTEM,
  screeningPrompt,
  type ReconciliationPair,
} from "@/lib/ai/prompts";
import {
  AIRateLimitError,
  AIResponseError,
  AIUnavailableError,
  type StructuredRequest,
} from "@/lib/ai/provider";
import { redact } from "@/lib/ai/redact";
import { renderMessage, toPromptMessages, windowMessages } from "@/lib/ai/transcript";
import {
  existingTaskUpdateSchema,
  extractedDecisionSchema,
  extractedItemSchema,
  extractionEnvelopeSchema,
  extractionOutputSchema,
  keepValid,
  MAYBE_SAME_THRESHOLD,
  reconciliationOutputSchema,
  SAME_TASK_THRESHOLD,
  screeningOutputSchema,
  titleSimilarity,
} from "@/lib/domain/discovery";
import type { StoredMessage } from "@/lib/import/plan";

import {
  persistFindings,
  type ConversationFindings,
  type Evidence,
  type ExistingTask,
} from "./persist";
import {
  AI_CONSENT_VERSION,
  EMPTY_PROGRESS,
  userPath,
  type AnalysisDeps,
  type JobProgress,
  type JobStage,
  type JobStatus,
  type JobView,
} from "./types";
import { allowanceToday, recordRequest, requestsUsedToday } from "./usage";

/**
 * Resumable analysis jobs.
 *
 * There is no background worker on the free stack. The open browser tab calls
 * `advanceJob` repeatedly; each call takes a short lease, does a bounded
 * amount of work, saves its position and returns. Every unit of work is
 * recorded on the conversation it concerns, so a call that dies midway loses
 * at most the request it was making, and the next call carries on.
 */

const LEASE_MS = 90_000;
const WORK_BUDGET_MS = 40_000;
const SCREEN_BATCH = 25;
const DIGEST_CHARS = 1_200;
const TRIVIAL_DIGEST_CHARS = 120;
const MAX_CONVERSATION_ATTEMPTS = 2;
const MAX_JOB_RETRIES = 5;
const MAX_RECONCILE_TASKS = 300;
const MAX_RECONCILE_PAIRS = 30;
const MAX_EVIDENCE = 5;

export class JobError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "JobError";
  }
}

type JobData = {
  status: JobStatus;
  stage: JobStage;
  progress: JobProgress;
  retryCount: number;
  message: string | null;
  leaseUntil: Timestamp | null;
  nextRequestAt: Timestamp | null;
};

function readJob(snapshot: DocumentSnapshot): JobData {
  const data = snapshot.data() ?? {};
  return {
    status: (data.status as JobStatus) ?? "running",
    stage: (data.stage as JobStage) ?? "screening",
    progress: { ...EMPTY_PROGRESS, ...(data.progress as Partial<JobProgress> | undefined) },
    retryCount: typeof data.retryCount === "number" ? data.retryCount : 0,
    message: typeof data.message === "string" ? data.message : null,
    leaseUntil: data.leaseUntil instanceof Timestamp ? data.leaseUntil : null,
    nextRequestAt: data.nextRequestAt instanceof Timestamp ? data.nextRequestAt : null,
  };
}

async function toView(
  deps: AnalysisDeps,
  uid: string,
  id: string,
  job: JobData,
  waitMs = 0,
): Promise<JobView> {
  return {
    id,
    status: job.status,
    stage: job.stage,
    progress: job.progress,
    message: job.message,
    waitMs,
    usage: {
      day: usageDay(deps.now()),
      aiRequests: await requestsUsedToday(deps, uid),
      dailyCap: deps.config.userDailyRequestCap,
    },
  };
}

async function assertConsent(deps: AnalysisDeps, uid: string): Promise<void> {
  const profile = (await deps.db.doc(userPath(uid)).get()).data();
  if (profile?.aiConsentAccepted !== true || profile?.aiConsentVersion !== AI_CONSENT_VERSION) {
    throw new JobError(403, "AI analysis needs your consent first.");
  }
}

/** Starts a job, or reopens the unfinished one. A user has at most one open job. */
export async function startJob(deps: AnalysisDeps, uid: string): Promise<JobView> {
  await assertConsent(deps, uid);
  const jobs = deps.db.collection(userPath(uid, "jobs"));
  const open = await jobs
    .where("status", "in", ["running", "paused_quota", "paused_error"])
    .limit(1)
    .get();

  if (!open.empty) {
    const existing = open.docs[0]!;
    await existing.ref.update({
      status: "running",
      message: null,
      retryCount: 0,
      updatedAt: FieldValue.serverTimestamp(),
    });
    return toView(deps, uid, existing.id, { ...readJob(existing), status: "running", message: null });
  }

  const created = jobs.doc();
  const job: JobData = {
    status: "running",
    stage: "screening",
    progress: { ...EMPTY_PROGRESS },
    retryCount: 0,
    message: null,
    leaseUntil: null,
    nextRequestAt: null,
  };
  await created.set({
    ...job,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
    completedAt: null,
  });
  return toView(deps, uid, created.id, job);
}

export async function getJob(deps: AnalysisDeps, uid: string, jobId: string): Promise<JobView> {
  const snapshot = await deps.db.doc(userPath(uid, "jobs", jobId)).get();
  if (!snapshot.exists) throw new JobError(404, "Job not found.");
  return toView(deps, uid, jobId, readJob(snapshot));
}

/** Signals that this call should stop and report, without failing the job. */
class StopAdvance extends Error {
  constructor(readonly waitMs: number) {
    super("stop");
  }
}

type Run = {
  deps: AnalysisDeps;
  uid: string;
  job: JobData;
  /** Model requests this call may still make. */
  budget: number;
  /** Requests left today under this user's own limit. */
  userLeft: number;
  /** Requests left today in the total shared by all users. */
  globalLeft: number;
  startedAt: number;
};

/** Says which of the two daily limits stopped the job. The shared one takes precedence. */
function quotaMessage(run: Run): string {
  return run.globalLeft <= 0
    ? "Recall's shared AI allowance for today is used up. Analysis resumes after the daily reset."
    : "You have used your AI allowance for today. Analysis resumes after the daily reset.";
}

/** One model request: paced, counted, and with quota and failures classified. */
async function ask<T>(run: Run, request: StructuredRequest<T>): Promise<T> {
  const { deps, job } = run;
  if (run.userLeft <= 0 || run.globalLeft <= 0) {
    job.status = "paused_quota";
    job.message = quotaMessage(run);
    throw new StopAdvance(0);
  }
  if (run.budget <= 0) throw new StopAdvance(0);

  const waitMs = (job.nextRequestAt?.toMillis() ?? 0) - deps.now().getTime();
  if (waitMs > 0) {
    if (waitMs > 15_000) throw new StopAdvance(waitMs);
    await deps.sleep(waitMs);
  }
  const interval = Math.ceil(60_000 / deps.config.requestsPerMinute);
  job.nextRequestAt = Timestamp.fromMillis(deps.now().getTime() + interval);
  run.budget--;

  try {
    const response = await deps.provider.generateStructured(request);
    run.userLeft--;
    run.globalLeft--;
    job.progress.aiRequests++;
    job.retryCount = 0;
    await recordRequest(deps, run.uid, response.usage);
    return response.data;
  } catch (error) {
    if (error instanceof AIRateLimitError) {
      if (error.daily) {
        job.status = "paused_quota";
        job.message = "The AI provider's daily limit was reached. Analysis resumes after it resets.";
        throw new StopAdvance(0);
      }
      const retryIn = Math.min(error.retryAfterMs ?? 30_000, 60_000);
      job.nextRequestAt = Timestamp.fromMillis(deps.now().getTime() + retryIn);
      throw new StopAdvance(retryIn);
    }
    if (error instanceof AIUnavailableError) {
      job.retryCount++;
      if (job.retryCount >= MAX_JOB_RETRIES) {
        job.status = "paused_error";
        job.message = "The AI provider kept failing. Try again later.";
        throw new StopAdvance(0);
      }
      const backoff = Math.min(2_000 * 2 ** job.retryCount, 60_000);
      job.nextRequestAt = Timestamp.fromMillis(deps.now().getTime() + backoff);
      throw new StopAdvance(backoff);
    }
    if (error instanceof AIResponseError) {
      // The request was made and counts against the allowance.
      run.userLeft--;
    run.globalLeft--;
      job.progress.aiRequests++;
      await recordRequest(deps, run.uid, { inputTokens: 0, outputTokens: 0 });
    }
    throw error;
  }
}

// ---- Stage 1: screening ------------------------------------------------------

async function screenBatch(run: Run): Promise<boolean> {
  const { deps, uid, job } = run;
  const page = await deps.db
    .collection(userPath(uid, "conversations"))
    .where("needsAnalysis", "==", true)
    .limit(SCREEN_BATCH)
    .get();
  if (page.empty) return false;

  const decided = new Map<string, { state: string; reason: string }>();
  const toScreen: { id: string; title: string; messageCount: number; digest: string }[] = [];

  for (const entry of page.docs) {
    const data = entry.data();
    const digest = typeof data.digest === "string" ? data.digest : "";
    const previous = (data.analysis as { state?: string } | undefined)?.state;
    if (data.excluded === true) {
      decided.set(entry.id, { state: "excluded", reason: "Excluded by you." });
    } else if (previous === "analysed") {
      // Already analysed once and since changed: go straight to extraction,
      // where its existing tasks are re-evaluated.
      decided.set(entry.id, { state: "shortlisted", reason: "Changed since last analysis." });
    } else if ((data.humanMessageCount ?? 0) < 1 || digest.length < TRIVIAL_DIGEST_CHARS) {
      decided.set(entry.id, { state: "skipped_trivial", reason: "Too short to contain work." });
    } else {
      toScreen.push({
        id: entry.id,
        title: redact(String(data.title ?? "")),
        messageCount: Number(data.messageCount ?? 0),
        digest: redact(digest).slice(0, DIGEST_CHARS),
      });
    }
  }

  if (toScreen.length > 0) {
    let results: { n: number; keep: boolean; reason: string }[] = [];
    try {
      const output = await ask(run, {
        role: "bulk",
        system: SCREENING_SYSTEM,
        prompt: screeningPrompt(toScreen.map((entry, index) => ({ n: index + 1, ...entry }))),
        schema: screeningOutputSchema,
        maxOutputTokens: 2_048,
      });
      results = output.results;
    } catch (error) {
      if (!(error instanceof AIResponseError)) throw error;
      // An unusable screening answer must not lose work: keep everything.
    }
    const byNumber = new Map(results.map((result) => [result.n, result]));
    toScreen.forEach((entry, index) => {
      const result = byNumber.get(index + 1);
      // No verdict for a conversation means it is kept, not dropped.
      decided.set(
        entry.id,
        result && !result.keep
          ? { state: "screened_out", reason: result.reason }
          : { state: "shortlisted", reason: result?.reason ?? "Kept: no screening verdict." },
      );
    });
  }

  const batch = deps.db.batch();
  for (const entry of page.docs) {
    const decision = decided.get(entry.id)!;
    batch.update(entry.ref, {
      needsAnalysis: false,
      analysis: {
        state: decision.state,
        reason: decision.reason.slice(0, 300),
        screenedAt: FieldValue.serverTimestamp(),
        attempts: 0,
      },
    });
    job.progress.screened++;
    if (decision.state === "shortlisted") job.progress.shortlisted++;
    else job.progress.skipped++;
  }
  await batch.commit();
  return true;
}

// ---- Stage 2: extraction -----------------------------------------------------

async function extractNext(run: Run): Promise<boolean> {
  const { deps, uid, job } = run;
  const page = await deps.db
    .collection(userPath(uid, "conversations"))
    .where("analysis.state", "==", "shortlisted")
    .limit(1)
    .get();
  const entry = page.docs[0];
  if (!entry) return false;
  const data = entry.data();

  const chunks = await entry.ref.collection("chunks").orderBy("index").get();
  const stored = chunks.docs.flatMap((chunk) => (chunk.data().messages ?? []) as StoredMessage[]);
  // A conversation is analysed within one call, so its findings are verified
  // and saved together. It may therefore use at most one call's requests.
  const perCall = deps.config.requestsPerAdvance;
  const allWindows = windowMessages(toPromptMessages(stored));
  const windows =
    allWindows.length <= perCall
      ? allWindows
      : [allWindows[0]!, ...allWindows.slice(allWindows.length - (perCall - 1))];

  if (windows.length > Math.min(run.userLeft, run.globalLeft)) {
    job.status = "paused_quota";
    job.message = quotaMessage(run);
    throw new StopAdvance(0);
  }
  // If this call cannot afford the whole conversation, the next one can.
  if (windows.length > run.budget) throw new StopAdvance(0);

  const taskDocs = await deps.db
    .collection(userPath(uid, "tasks"))
    .where("sourceConversationId", "==", entry.id)
    .limit(30)
    .get();
  const existing: ExistingTask[] = taskDocs.docs.map((task, index) => ({
    ref: `t${index + 1}`,
    id: task.id,
    title: String(task.data().title ?? ""),
    status: String(task.data().status ?? ""),
  }));

  const findings: ConversationFindings[] = [];
  let malformed = 0;
  try {
    for (const [index, window] of windows.entries()) {
      const raw = await ask(run, {
        role: "bulk",
        system: EXTRACTION_SYSTEM,
        prompt: extractionPrompt({
          title: redact(String(data.title ?? "")),
          transcript: window.map(renderMessage).join("\n\n"),
          part: { index, total: windows.length },
          existingTasks: existing.map(({ ref, title, status }) => ({ ref, title: redact(title), status })),
        }),
        // The model is shown the strict schema; the answer is read leniently
        // so one malformed item does not discard the rest.
        schema: extractionEnvelopeSchema,
        modelSchema: extractionOutputSchema,
        maxOutputTokens: 4_096,
      });
      const envelope = raw;
      const items = keepValid(extractedItemSchema, envelope.items);
      const decisions = keepValid(extractedDecisionSchema, envelope.decisions);
      const updates = keepValid(existingTaskUpdateSchema, envelope.existingTasks);
      malformed += items.dropped + decisions.dropped + updates.dropped;
      findings.push({
        project: envelope.project,
        items: items.valid,
        decisions: decisions.valid,
        existingTasks: updates.valid,
        messages: window,
      });
    }
  } catch (error) {
    if (!(error instanceof AIResponseError)) throw error;
    const attempts = Number((data.analysis as { attempts?: number } | undefined)?.attempts ?? 0) + 1;
    const giveUp = attempts >= MAX_CONVERSATION_ATTEMPTS;
    await entry.ref.update({
      "analysis.attempts": attempts,
      ...(giveUp ? { "analysis.state": "failed", "analysis.reason": "The AI answer could not be used." } : {}),
    });
    if (giveUp) job.progress.failed++;
    return true;
  }

  const outcome = await persistFindings(
    deps,
    uid,
    {
      id: entry.id,
      title: String(data.title ?? ""),
      updatedAtSource: data.updatedAtSource instanceof Timestamp ? data.updatedAtSource : null,
    },
    findings,
    existing,
  );
  job.progress.analysed++;
  job.progress.tasksCreated += outcome.created;
  job.progress.tasksUpdated += outcome.updated;
  job.progress.tasksCompleted += outcome.completed;
  job.progress.discarded += outcome.discarded + malformed;
  return true;
}

// ---- Stage 3: reconciliation -------------------------------------------------

type OpenTask = {
  id: string;
  title: string;
  description: string;
  confidence: number;
  evidence: Evidence[];
  sourceConversationIds: string[];
  discoveredAt: number;
};

/**
 * Merges discoveries of the same task from different conversations. Only
 * tasks still awaiting review are merged; anything the user has acted on is
 * left alone. Near-identical titles merge directly; plausible matches are put
 * to the model in one request.
 */
async function reconcile(run: Run): Promise<void> {
  const { deps, uid, job } = run;
  const snapshot = await deps.db
    .collection(userPath(uid, "tasks"))
    .where("status", "==", "awaiting_review")
    .limit(MAX_RECONCILE_TASKS)
    .get();
  const tasks: OpenTask[] = snapshot.docs.map((entry) => {
    const data = entry.data();
    return {
      id: entry.id,
      title: String(data.title ?? ""),
      description: String(data.description ?? ""),
      confidence: Number(data.confidence ?? 0),
      evidence: (data.evidence ?? []) as Evidence[],
      sourceConversationIds: (data.sourceConversationIds ?? []) as string[],
      discoveredAt: data.discoveredAt instanceof Timestamp ? data.discoveredAt.toMillis() : 0,
    };
  });

  const sure: [OpenTask, OpenTask][] = [];
  const maybe: [OpenTask, OpenTask][] = [];
  for (let i = 0; i < tasks.length; i++) {
    for (let j = i + 1; j < tasks.length; j++) {
      const a = tasks[i]!;
      const b = tasks[j]!;
      // Two tasks from the same conversation were already told apart there.
      if (a.sourceConversationIds.some((id) => b.sourceConversationIds.includes(id))) continue;
      const similarity = titleSimilarity(a.title, b.title);
      if (similarity >= SAME_TASK_THRESHOLD) sure.push([a, b]);
      else if (similarity >= MAYBE_SAME_THRESHOLD && maybe.length < MAX_RECONCILE_PAIRS) maybe.push([a, b]);
    }
  }

  if (maybe.length > 0) {
    const pairs: ReconciliationPair[] = maybe.map(([a, b], index) => ({
      n: index + 1,
      a: redact(`${a.title}. ${a.description}`).slice(0, 400),
      b: redact(`${b.title}. ${b.description}`).slice(0, 400),
    }));
    try {
      const output = await ask(run, {
        role: "bulk",
        system: RECONCILIATION_SYSTEM,
        prompt: reconciliationPrompt(pairs),
        schema: reconciliationOutputSchema,
        maxOutputTokens: 1_024,
      });
      for (const verdict of output.pairs) {
        const pair = maybe[verdict.n - 1];
        if (pair && verdict.same) sure.push(pair);
      }
    } catch (error) {
      if (!(error instanceof AIResponseError)) throw error;
      // Without a usable verdict the pairs stay separate; the user can merge.
    }
  }

  const absorbed = new Set<string>();
  const batch = deps.db.batch();
  for (const [a, b] of sure) {
    if (absorbed.has(a.id) || absorbed.has(b.id)) continue;
    const [keep, drop] = a.discoveredAt <= b.discoveredAt ? [a, b] : [b, a];
    absorbed.add(drop.id);
    keep.evidence = [...keep.evidence, ...drop.evidence]
      .filter((item, at, all) => all.findIndex((other) => other.quote === item.quote) === at)
      .slice(0, MAX_EVIDENCE);
    keep.sourceConversationIds = [...new Set([...keep.sourceConversationIds, ...drop.sourceConversationIds])];
    // Corroboration from a second conversation raises confidence a little.
    keep.confidence = Math.min(0.95, Math.round((Math.max(keep.confidence, drop.confidence) + 0.05) * 100) / 100);
    batch.update(deps.db.doc(userPath(uid, "tasks", keep.id)), {
      evidence: keep.evidence,
      sourceConversationIds: keep.sourceConversationIds,
      confidence: keep.confidence,
      needsAttention: keep.confidence < 0.6,
      updatedAt: FieldValue.serverTimestamp(),
    });
    batch.delete(deps.db.doc(userPath(uid, "tasks", drop.id)));
    job.progress.tasksMerged++;
  }
  if (absorbed.size > 0) await batch.commit();
}

// ---- The loop ----------------------------------------------------------------

/**
 * Does one bounded slice of work on a job. Safe to call repeatedly and from
 * two tabs: a lease makes concurrent calls take turns.
 */
export async function advanceJob(
  deps: AnalysisDeps,
  uid: string,
  jobId: string,
  aiAllowed: boolean,
): Promise<JobView> {
  if (!aiAllowed) throw new JobError(403, "AI analysis is not enabled for this account.");
  await assertConsent(deps, uid);
  const ref = deps.db.doc(userPath(uid, "jobs", jobId));

  const leased = await deps.db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists) throw new JobError(404, "Job not found.");
    const job = readJob(snapshot);
    if (job.status !== "running") return { job, held: false };
    if (job.leaseUntil && job.leaseUntil.toMillis() > deps.now().getTime()) return { job, held: false };
    transaction.update(ref, { leaseUntil: Timestamp.fromMillis(deps.now().getTime() + LEASE_MS) });
    return { job, held: true };
  });

  const { job } = leased;
  if (!leased.held) {
    // Finished, paused, or another call is working on it right now.
    return toView(deps, uid, jobId, job, job.status === "running" ? 3_000 : 0);
  }

  const allowance = await allowanceToday(deps, uid);
  const run: Run = {
    deps,
    uid,
    job,
    budget: deps.config.requestsPerAdvance,
    userLeft: allowance.userLeft,
    globalLeft: allowance.globalLeft,
    startedAt: deps.now().getTime(),
  };

  let waitMs = 0;
  try {
    while (job.status === "running" && deps.now().getTime() - run.startedAt < WORK_BUDGET_MS) {
      if (job.stage === "screening") {
        if (!(await screenBatch(run))) job.stage = "extraction";
      } else if (job.stage === "extraction") {
        if (!(await extractNext(run))) job.stage = "reconciliation";
      } else if (job.stage === "reconciliation") {
        await reconcile(run);
        job.stage = "done";
      } else {
        job.status = "completed";
        job.message = null;
      }
      // Out of requests for this call: stop before starting work that needs one.
      if (run.budget <= 0 && job.status === "running" && job.stage !== "done") break;
    }
  } catch (error) {
    if (error instanceof StopAdvance) {
      waitMs = error.waitMs;
    } else {
      // An unexpected failure must not leave the lease held.
      await ref.update({ leaseUntil: null, updatedAt: FieldValue.serverTimestamp() });
      throw error;
    }
  }

  await ref.update({
    status: job.status,
    stage: job.stage,
    progress: job.progress,
    retryCount: job.retryCount,
    message: job.message,
    nextRequestAt: job.nextRequestAt,
    leaseUntil: null,
    updatedAt: FieldValue.serverTimestamp(),
    ...(job.status === "completed" ? { completedAt: FieldValue.serverTimestamp() } : {}),
  });
  return toView(deps, uid, jobId, job, waitMs);
}

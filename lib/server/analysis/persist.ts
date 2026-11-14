import "server-only";

import { FieldValue, Timestamp, type DocumentReference } from "firebase-admin/firestore";

import type { PromptMessage } from "@/lib/ai/transcript";
import { verifyQuote } from "@/lib/ai/verify";
import {
  becomesTask,
  dedupeKey,
  NEEDS_ATTENTION_BELOW,
  PRIORITY_RANK,
  scoreConfidence,
  type ExistingTaskUpdate,
  type ExtractedDecision,
  type ExtractedItem,
} from "@/lib/domain/discovery";
import { sha256Hex } from "@/lib/domain/hash";

import { userPath, type AnalysisDeps } from "./types";

export type Evidence = {
  kind: "commitment" | "completion";
  conversationId: string;
  messageId: string;
  messageAt: string | null;
  sender: "human" | "assistant";
  quote: string;
};

export type ExistingTask = { ref: string; id: string; title: string; status: string };

export type ConversationFindings = {
  project: { name: string; description: string } | null;
  items: ExtractedItem[];
  decisions: ExtractedDecision[];
  existingTasks: ExistingTaskUpdate[];
  /** The window each finding came from, to verify quotes against. */
  messages: PromptMessage[];
};

export type PersistOutcome = {
  created: number;
  updated: number;
  completed: number;
  discarded: number;
  /** Counts by commitment class, including those that did not become tasks. */
  classes: Record<string, number>;
};

const MAX_EVIDENCE = 5;
const MAX_DECISIONS = 30;
const MAX_PROJECT_CONVERSATIONS = 100;

function timestampOrNull(iso: string | null): Timestamp | null {
  if (!iso) return null;
  const time = Date.parse(iso);
  return Number.isNaN(time) ? null : Timestamp.fromMillis(time);
}

/** Ids are derived by the server from content. The model never supplies one. */
export async function taskIdFor(conversationId: string, title: string): Promise<string> {
  return (await sha256Hex(`${conversationId}|${dedupeKey(title)}`)).slice(0, 32);
}

export async function projectIdFor(name: string): Promise<string> {
  return `p_${(await sha256Hex(dedupeKey(name) || name.toLowerCase())).slice(0, 24)}`;
}

/**
 * Validates one conversation's findings against the transcript and writes the
 * survivors. Nothing reaches Firestore without a quote found in a real
 * message. A user's decision on a task (approved, dismissed, edited) is never
 * overwritten by a later analysis.
 */
export async function persistFindings(
  deps: AnalysisDeps,
  uid: string,
  conversation: { id: string; title: string; updatedAtSource: Timestamp | null },
  findings: ConversationFindings[],
  existing: ExistingTask[],
): Promise<PersistOutcome> {
  const { db } = deps;
  const outcome: PersistOutcome = { created: 0, updated: 0, completed: 0, discarded: 0, classes: {} };
  const batch = db.batch();
  const now = FieldValue.serverTimestamp();
  const seenTaskIds = new Set<string>();

  // ---- Project -------------------------------------------------------------
  const projectFinding = findings.find((finding) => finding.project)?.project ?? null;
  let projectId: string | null = null;
  const decisions: { text: string; conversationId: string; messageId: string; quote: string }[] = [];

  for (const finding of findings) {
    for (const decision of finding.decisions) {
      const verified = verifyQuote(decision.quote, decision.ref, finding.messages);
      if (!verified) {
        outcome.discarded++;
        continue;
      }
      decisions.push({
        text: decision.text,
        conversationId: conversation.id,
        messageId: verified.message.id,
        quote: decision.quote,
      });
    }
  }

  // ---- Items ---------------------------------------------------------------
  type Pending = { ref: DocumentReference; data: Record<string, unknown>; completed: boolean };
  const pending: Pending[] = [];

  for (const finding of findings) {
    for (const item of finding.items) {
      outcome.classes[item.commitmentClass] = (outcome.classes[item.commitmentClass] ?? 0) + 1;
      if (!becomesTask(item.commitmentClass)) continue;

      const commitment = verifyQuote(item.evidenceQuote, item.evidenceRef, finding.messages);
      if (!commitment) {
        outcome.discarded++;
        continue;
      }

      const id = await taskIdFor(conversation.id, item.title);
      if (seenTaskIds.has(id)) continue;
      seenTaskIds.add(id);

      // A due date is accepted only with its own verified quote.
      const dueVerified =
        item.dueDate !== null && verifyQuote(item.dueDateQuote, null, finding.messages) !== null;

      // Completion needs a verified quote from a message after the commitment.
      const completion = item.completed
        ? verifyQuote(item.completionQuote, item.completionRef, finding.messages)
        : null;
      const completed = completion !== null && completion.message.ordinal > commitment.message.ordinal;

      const confidence = scoreConfidence({
        commitmentClass: item.commitmentClass,
        evidenceSender: commitment.message.sender,
        evidenceRefExact: commitment.refExact,
        hasVerifiedDueDate: dueVerified,
      });

      const evidence: Evidence[] = [
        {
          kind: "commitment",
          conversationId: conversation.id,
          messageId: commitment.message.id,
          messageAt: commitment.message.createdAt,
          sender: commitment.message.sender,
          quote: item.evidenceQuote,
        },
      ];
      if (completed && completion) {
        evidence.push({
          kind: "completion",
          conversationId: conversation.id,
          messageId: completion.message.id,
          messageAt: completion.message.createdAt,
          sender: completion.message.sender,
          quote: item.completionQuote ?? "",
        });
      }

      pending.push({
        ref: db.doc(userPath(uid, "tasks", id)),
        completed,
        data: {
          title: item.title,
          description: item.description,
          category: item.category,
          commitmentClass: item.commitmentClass,
          priority: item.priority,
          priorityRank: PRIORITY_RANK[item.priority],
          confidence,
          needsAttention: confidence < NEEDS_ATTENTION_BELOW,
          evidence,
          suggestedNextAction: item.suggestedNextAction,
          dueDate: dueVerified ? item.dueDate : null,
          originalAt: timestampOrNull(commitment.message.createdAt),
          lastActivityAt: conversation.updatedAtSource,
          sourceConversationId: conversation.id,
          sourceConversationIds: [conversation.id],
          dedupeKey: dedupeKey(item.title),
        },
      });
    }
  }

  if (projectFinding && (pending.length > 0 || decisions.length > 0)) {
    projectId = await projectIdFor(projectFinding.name);
    const ref = db.doc(userPath(uid, "projects", projectId));
    const snapshot = await ref.get();
    const previous = (snapshot.data()?.decisions ?? []) as typeof decisions;
    const known = new Set(previous.map((decision) => decision.text.toLowerCase()));
    const merged = [
      ...previous,
      ...decisions.filter((decision) => !known.has(decision.text.toLowerCase())),
    ].slice(-MAX_DECISIONS);

    if (snapshot.exists) {
      const conversationIds = (snapshot.data()?.conversationIds ?? []) as string[];
      batch.update(ref, {
        ...(conversationIds.length < MAX_PROJECT_CONVERSATIONS
          ? { conversationIds: FieldValue.arrayUnion(conversation.id) }
          : {}),
        decisions: merged,
        lastActivityAt: conversation.updatedAtSource,
        updatedAt: now,
      });
    } else {
      batch.set(ref, {
        name: projectFinding.name,
        description: projectFinding.description,
        conversationIds: [conversation.id],
        decisions: merged,
        archived: false,
        lastActivityAt: conversation.updatedAtSource,
        createdAt: now,
        updatedAt: now,
      });
    }
  }

  // ---- Write tasks, respecting what the user already decided ---------------
  const snapshots = pending.length > 0 ? await db.getAll(...pending.map((entry) => entry.ref)) : [];
  pending.forEach((entry, index) => {
    const saved = snapshots[index];
    if (!saved?.exists) {
      batch.set(entry.ref, {
        ...entry.data,
        projectId,
        status: entry.completed ? "completed" : "awaiting_review",
        completionSuggested: false,
        remindOn: null,
        lastReviewedAt: null,
        discoveredAt: now,
        createdAt: now,
        updatedAt: now,
      });
      if (entry.completed) outcome.completed++;
      else outcome.created++;
      return;
    }
    const status = saved.data()?.status;
    if (status === "awaiting_review") {
      // Not yet reviewed: refresh what the AI found.
      batch.update(entry.ref, {
        ...entry.data,
        ...(entry.completed ? { status: "completed" } : {}),
        updatedAt: now,
      });
      if (entry.completed) outcome.completed++;
      else outcome.updated++;
    } else if (entry.completed && (status === "approved" || status === "in_progress")) {
      // The user owns this task. Offer the completion; do not apply it.
      batch.update(entry.ref, {
        completionSuggested: true,
        evidence: [...((saved.data()?.evidence ?? []) as Evidence[]), ...entry.data.evidence as Evidence[]]
          .filter((item, at, all) => all.findIndex((other) => other.quote === item.quote) === at)
          .slice(0, MAX_EVIDENCE),
        lastActivityAt: conversation.updatedAtSource,
        updatedAt: now,
      });
      outcome.updated++;
    }
    // Dismissed and completed tasks are left exactly as they are.
  });

  // ---- Updates to tasks recorded from an earlier analysis ------------------
  const byRef = new Map(existing.map((task) => [task.ref, task]));
  for (const finding of findings) {
    for (const update of finding.existingTasks) {
      const task = byRef.get(update.ref);
      if (!task || update.state !== "completed" || seenTaskIds.has(task.id)) continue;
      const verified = verifyQuote(update.evidenceQuote, update.evidenceRef, finding.messages);
      if (!verified) {
        outcome.discarded++;
        continue;
      }
      seenTaskIds.add(task.id);
      const completionEvidence: Evidence = {
        kind: "completion",
        conversationId: conversation.id,
        messageId: verified.message.id,
        messageAt: verified.message.createdAt,
        sender: verified.message.sender,
        quote: update.evidenceQuote ?? "",
      };
      const ref = db.doc(userPath(uid, "tasks", task.id));
      if (task.status === "awaiting_review") {
        batch.update(ref, {
          status: "completed",
          evidence: FieldValue.arrayUnion(completionEvidence),
          lastActivityAt: conversation.updatedAtSource,
          updatedAt: now,
        });
        outcome.completed++;
      } else if (task.status === "approved" || task.status === "in_progress") {
        batch.update(ref, {
          completionSuggested: true,
          evidence: FieldValue.arrayUnion(completionEvidence),
          lastActivityAt: conversation.updatedAtSource,
          updatedAt: now,
        });
        outcome.updated++;
      }
    }
  }

  // ---- The conversation's own analysis record ------------------------------
  batch.update(db.doc(userPath(uid, "conversations", conversation.id)), {
    needsAnalysis: false,
    analysis: {
      state: "analysed",
      analysedAt: now,
      provider: deps.provider.name,
      tasks: outcome.created + outcome.updated + outcome.completed,
      discarded: outcome.discarded,
      classes: outcome.classes,
      projectId,
    },
  });

  await batch.commit();
  return outcome;
}

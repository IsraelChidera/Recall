import "server-only";

import { FieldValue } from "firebase-admin/firestore";

import { RESUME_SYSTEM, resumePrompt } from "@/lib/ai/prompts";
import { AIRateLimitError, AIResponseError, AIUnavailableError } from "@/lib/ai/provider";
import { renderMessage, toPromptMessages } from "@/lib/ai/transcript";
import { verifyQuote } from "@/lib/ai/verify";
import type { StoredMessage } from "@/lib/import/plan";
import {
  INSIGHT_LIMITS,
  resumeResponseSchema,
  type InsightKind,
  type InsightPoint,
  type ResumeResponse,
} from "@/lib/resume/insights";
import { selectForResume } from "@/lib/resume/select";
import { assertConsent, JobError } from "@/lib/server/analysis/job";
import { userPath, type AnalysisDeps } from "@/lib/server/analysis/types";
import { AllowanceError, reserveRequest, settleRequest } from "@/lib/server/analysis/usage";

export type GeneratedInsights = { points: InsightPoint[]; generatedAt: string };

const clip = (text: string, limit: number) => {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= limit ? clean : `${clean.slice(0, limit - 1).trimEnd()}…`;
};

/**
 * Prepares the AI part of a continuation prompt for one task: one request to
 * the quality model over a redacted excerpt of the task's source conversation.
 *
 * Every path is built from `uid`, which the caller takes from a verified
 * token. Each point the model returns is kept only if its quote is found in
 * the transcript it was shown.
 */
export async function generateResumeInsights(
  deps: AnalysisDeps,
  uid: string,
  taskId: string,
): Promise<GeneratedInsights> {
  await assertConsent(deps, uid);

  const taskRef = deps.db.doc(userPath(uid, "tasks", taskId));
  const task = (await taskRef.get()).data();
  if (!task) throw new JobError(404, "Task not found.");

  const conversationId = typeof task.sourceConversationId === "string" ? task.sourceConversationId : "";
  const conversationRef = conversationId ? deps.db.doc(userPath(uid, "conversations", conversationId)) : null;
  const conversation = conversationRef ? (await conversationRef.get()).data() : undefined;
  if (!conversationRef || !conversation) {
    throw new JobError(409, "The original conversation is no longer stored, so there is nothing to summarise.");
  }
  if (conversation.excluded === true) {
    throw new JobError(409, "You have left this conversation out of AI analysis.");
  }

  const chunks = await conversationRef.collection("chunks").orderBy("index").get();
  const stored = chunks.docs.flatMap((chunk) => (chunk.data().messages ?? []) as StoredMessage[]);
  const all = toPromptMessages(stored).filter((message) => message.text.trim().length > 0);
  if (all.length === 0) throw new JobError(409, "The original conversation has no text to summarise.");

  const evidence = Array.isArray(task.evidence) ? (task.evidence as Record<string, unknown>[]) : [];
  const evidenceId = evidence.find((entry) => entry.kind !== "completion" && typeof entry.messageId === "string")
    ?.messageId as string | undefined;
  const shown = selectForResume(all, evidenceId ?? null);

  // Claimed before the request is made, so parallel calls cannot overrun a limit.
  try {
    await reserveRequest(deps, uid);
  } catch (error) {
    if (!(error instanceof AllowanceError)) throw error;
    if (error.reason === "shared") {
      throw new JobError(429, "Recall's shared AI allowance for today is used up. Try again after the daily reset.");
    }
    if (error.reason === "user") {
      throw new JobError(429, "You have used your AI allowance for today. Try again after the daily reset.");
    }
    throw new JobError(429, `Wait ${Math.max(1, Math.ceil(error.waitMs / 1000))} seconds and try again.`);
  }

  let data: ResumeResponse;
  try {
    const response = await deps.provider.generateStructured({
      role: "quality",
      system: RESUME_SYSTEM,
      prompt: resumePrompt({
        taskTitle: typeof task.title === "string" ? task.title : "",
        conversationTitle: typeof conversation.title === "string" ? conversation.title : "",
        transcript: shown.map(renderMessage).join("\n\n"),
        partial: shown.length < all.length,
      }),
      schema: resumeResponseSchema,
      maxOutputTokens: 2_000,
    });
    await settleRequest(deps, uid, response.usage);
    data = response.data;
  } catch (error) {
    // Not served by the provider: hand the claim back.
    if (error instanceof AIRateLimitError || error instanceof AIUnavailableError) {
      await settleRequest(deps, uid, null);
    }
    if (error instanceof AIRateLimitError) {
      throw new JobError(
        429,
        error.daily
          ? "The AI provider's daily limit was reached. Try again after it resets."
          : "The AI provider is busy. Wait a minute and try again.",
      );
    }
    if (error instanceof AIUnavailableError) {
      throw new JobError(503, "The AI provider could not be reached. Your prompt below still works without it.");
    }
    if (error instanceof AIResponseError) {
      // The request was made, so the claim stands.
      throw new JobError(502, "The AI answer could not be used. Your prompt below still works without it.");
    }
    throw error;
  }

  const points: InsightPoint[] = [];
  const keep = (kind: InsightKind, entries: ResumeResponse["progress"]) => {
    let kept = 0;
    for (const entry of entries) {
      if (kept >= INSIGHT_LIMITS.perKind) break;
      // Only the messages the model was shown count as support.
      const verified = verifyQuote(entry.quote, entry.ref, shown);
      if (!verified) continue;
      points.push({
        kind,
        text: clip(entry.text, INSIGHT_LIMITS.textChars),
        quote: clip(entry.quote, INSIGHT_LIMITS.quoteChars),
        sender: verified.message.sender,
      });
      kept++;
    }
  };
  keep("progress", data.progress);
  keep("decision", data.decisions);
  keep("open_question", data.openQuestions);

  const generatedAt = deps.now();
  await taskRef.update({
    resume: { points, generatedAt, conversationId },
    updatedAt: FieldValue.serverTimestamp(),
  });
  return { points, generatedAt: generatedAt.toISOString() };
}

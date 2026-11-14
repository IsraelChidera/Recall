import "server-only";

import { FieldValue } from "firebase-admin/firestore";

import { usageDay } from "@/lib/ai/config";
import type { TokenUsage } from "@/lib/ai/provider";

import { userPath, type AnalysisDeps } from "./types";

/**
 * The daily AI request counter. It lives in a document the browser can read
 * but never write, so the cap cannot be reset from the client.
 */
export async function requestsUsedToday(deps: AnalysisDeps, uid: string): Promise<number> {
  const snapshot = await deps.db.doc(userPath(uid, "usage", usageDay(deps.now()))).get();
  const used = snapshot.data()?.aiRequests;
  return typeof used === "number" ? used : 0;
}

export async function recordRequest(
  deps: AnalysisDeps,
  uid: string,
  usage: TokenUsage,
): Promise<void> {
  await deps.db.doc(userPath(uid, "usage", usageDay(deps.now()))).set(
    {
      aiRequests: FieldValue.increment(1),
      inputTokens: FieldValue.increment(usage.inputTokens),
      outputTokens: FieldValue.increment(usage.outputTokens),
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
}

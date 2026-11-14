import "server-only";

import { FieldValue } from "firebase-admin/firestore";

import { usageDay, type AIConfig } from "@/lib/ai/config";
import type { TokenUsage } from "@/lib/ai/provider";

import { userPath, type AnalysisDeps } from "./types";

/**
 * Daily AI request counters. There are two, because there are two limits:
 *
 * - `users/{uid}/usage/{day}` counts one user's requests. The user can read
 *   it but never write it, so the cap cannot be reset from the browser.
 * - `usage/{day}` counts every user's requests together. The Gemini quota
 *   belongs to the project, so this is what actually protects it. No client
 *   can read or write it.
 *
 * Both are written only here, through the Admin SDK.
 */
const globalPath = (day: string) => `usage/${day}`;

const count = (value: unknown) => (typeof value === "number" ? value : 0);

export type Allowance = {
  userUsed: number;
  globalUsed: number;
  /** Requests left today under the user's own limit. */
  userLeft: number;
  /** Requests left today in the total shared by all users. */
  globalLeft: number;
};

export function allowanceFrom(
  config: Pick<AIConfig, "dailyRequestCap" | "userDailyRequestCap">,
  userUsed: number,
  globalUsed: number,
): Allowance {
  const userLeft = Math.max(0, config.userDailyRequestCap - userUsed);
  const globalLeft = Math.max(0, config.dailyRequestCap - globalUsed);
  return { userUsed, globalUsed, userLeft, globalLeft };
}

export async function allowanceToday(deps: AnalysisDeps, uid: string): Promise<Allowance> {
  const day = usageDay(deps.now());
  const [user, global] = await deps.db.getAll(
    deps.db.doc(userPath(uid, "usage", day)),
    deps.db.doc(globalPath(day)),
  );
  return allowanceFrom(deps.config, count(user?.data()?.aiRequests), count(global?.data()?.aiRequests));
}

export async function requestsUsedToday(deps: AnalysisDeps, uid: string): Promise<number> {
  const snapshot = await deps.db.doc(userPath(uid, "usage", usageDay(deps.now()))).get();
  return count(snapshot.data()?.aiRequests);
}

/** Counts one request against both the user and the shared total, atomically. */
export async function recordRequest(
  deps: AnalysisDeps,
  uid: string,
  usage: TokenUsage,
): Promise<void> {
  const day = usageDay(deps.now());
  const increment = {
    aiRequests: FieldValue.increment(1),
    inputTokens: FieldValue.increment(usage.inputTokens),
    outputTokens: FieldValue.increment(usage.outputTokens),
    updatedAt: FieldValue.serverTimestamp(),
  };
  const batch = deps.db.batch();
  batch.set(deps.db.doc(userPath(uid, "usage", day)), increment, { merge: true });
  batch.set(deps.db.doc(globalPath(day)), increment, { merge: true });
  await batch.commit();
}

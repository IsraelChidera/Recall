import "server-only";

import { FieldValue, Timestamp } from "firebase-admin/firestore";

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

/** Why a single request was not allowed to start. */
export class AllowanceError extends Error {
  constructor(
    readonly reason: "user" | "shared" | "pace",
    /** For "pace": how long to wait before trying again. */
    readonly waitMs = 0,
  ) {
    super(`AI request not allowed: ${reason}`);
    this.name = "AllowanceError";
  }
}

/**
 * Claims one request against both daily limits before it is made, in a
 * transaction. Several requests arriving at once therefore cannot each see
 * the same spare allowance and overrun a limit together. It also spaces a
 * user's one-off requests by the per-minute interval, so one person cannot
 * use up the provider's per-minute quota for everyone.
 *
 * Used for one-off requests, which can arrive in parallel. Analysis jobs are
 * already serialised per user by the job lease.
 */
export async function reserveRequest(deps: AnalysisDeps, uid: string): Promise<void> {
  const now = deps.now();
  const day = usageDay(now);
  const userRef = deps.db.doc(userPath(uid, "usage", day));
  const globalRef = deps.db.doc(globalPath(day));
  const interval = Math.ceil(60_000 / deps.config.requestsPerMinute);

  await deps.db.runTransaction(async (transaction) => {
    const [user, global] = await transaction.getAll(userRef, globalRef);
    const allowance = allowanceFrom(
      deps.config,
      count(user?.data()?.aiRequests),
      count(global?.data()?.aiRequests),
    );
    if (allowance.globalLeft <= 0) throw new AllowanceError("shared");
    if (allowance.userLeft <= 0) throw new AllowanceError("user");

    const last = user?.data()?.lastSingleRequestAt as Timestamp | undefined;
    const waitMs = (last?.toMillis() ?? 0) + interval - now.getTime();
    if (waitMs > 0) throw new AllowanceError("pace", waitMs);

    const claim = { aiRequests: FieldValue.increment(1), updatedAt: FieldValue.serverTimestamp() };
    transaction.set(userRef, { ...claim, lastSingleRequestAt: Timestamp.fromDate(now) }, { merge: true });
    transaction.set(globalRef, claim, { merge: true });
  });
}

/**
 * Completes a reserved request. With token counts, they are added to the
 * totals. With `null`, the request was never served (the provider was down or
 * refused it), so the claim is handed back.
 */
export async function settleRequest(deps: AnalysisDeps, uid: string, usage: TokenUsage | null): Promise<void> {
  const day = usageDay(deps.now());
  const change =
    usage === null
      ? { aiRequests: FieldValue.increment(-1), updatedAt: FieldValue.serverTimestamp() }
      : {
          inputTokens: FieldValue.increment(usage.inputTokens),
          outputTokens: FieldValue.increment(usage.outputTokens),
          updatedAt: FieldValue.serverTimestamp(),
        };
  const batch = deps.db.batch();
  batch.set(deps.db.doc(userPath(uid, "usage", day)), change, { merge: true });
  batch.set(deps.db.doc(globalPath(day)), change, { merge: true });
  await batch.commit();
}

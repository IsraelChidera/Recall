"use client";

import {
  collection,
  doc,
  getCountFromServer,
  getDoc,
  getDocs,
  limit,
  query,
  serverTimestamp,
  updateDoc,
  where,
} from "firebase/firestore";
import { useCallback, useEffect, useRef, useState } from "react";

import { authFetch } from "@/lib/auth/api-client";
import { AI_CONSENT_VERSION } from "@/lib/domain/consent";
import { getFirebaseServices } from "@/lib/firebase/client";
import type { JobView } from "@/lib/server/analysis/types";

export type Finding = { id: string; title: string; quote: string; needsAttention: boolean };

export type Overview = {
  aiAllowed: boolean;
  consented: boolean;
  conversations: number;
  waiting: number;
  toReview: number;
  findings: Finding[];
};

export type AnalysisState =
  | { name: "loading" }
  | { name: "unavailable" }
  | { name: "ready"; overview: Overview; job: JobView | null; running: boolean; error: string | null };

async function loadOverview(uid: string): Promise<Overview> {
  const { db } = getFirebaseServices();
  const conversations = collection(db, "users", uid, "conversations");
  const tasks = collection(db, "users", uid, "tasks");
  const awaiting = query(tasks, where("status", "==", "awaiting_review"));

  const [session, profile, total, waiting, toReview, sample] = await Promise.all([
    authFetch("/api/session").then(async (response) => {
      if (!response.ok) throw new Error("session");
      return (await response.json()) as { aiAllowed: boolean };
    }),
    getDoc(doc(db, "users", uid)),
    getCountFromServer(conversations),
    getCountFromServer(
      query(conversations, where("needsAnalysis", "==", true), where("excluded", "==", false)),
    ),
    getCountFromServer(awaiting),
    getDocs(query(awaiting, limit(5))),
  ]);

  const data = profile.data();
  return {
    aiAllowed: session.aiAllowed,
    consented: data?.aiConsentAccepted === true && data?.aiConsentVersion === AI_CONSENT_VERSION,
    conversations: total.data().count,
    waiting: waiting.data().count,
    toReview: toReview.data().count,
    findings: sample.docs.map((entry) => {
      const task = entry.data();
      const evidence = (task.evidence ?? []) as { quote?: string }[];
      return {
        id: entry.id,
        title: String(task.title ?? ""),
        quote: String(evidence[0]?.quote ?? ""),
        needsAttention: task.needsAttention === true,
      };
    }),
  };
}

async function postJob(path: string): Promise<JobView> {
  const response = await authFetch(path, { method: "POST" });
  const body = (await response.json().catch(() => ({}))) as JobView & { error?: string };
  if (!response.ok) throw new Error(body.error ?? "Analysis could not continue. Try again.");
  return body;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Drives an analysis job from the browser. The server does a bounded slice of
 * work per call; this loop keeps calling while the tab is open. Closing the
 * tab simply stops the loop, and the job continues from its saved position
 * next time.
 */
export function useAnalysis(uid: string) {
  const [state, setState] = useState<AnalysisState>({ name: "loading" });
  const stop = useRef(false);

  const refresh = useCallback(
    async (patch: { job?: JobView | null; running?: boolean; error?: string | null } = {}) => {
      try {
        const overview = await loadOverview(uid);
        setState((previous) => ({
          name: "ready",
          overview,
          job: patch.job !== undefined ? patch.job : previous.name === "ready" ? previous.job : null,
          running: patch.running ?? false,
          error: patch.error ?? null,
        }));
      } catch {
        setState({ name: "unavailable" });
      }
    },
    [uid],
  );

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loads remote data on mount
    void refresh();
    return () => {
      stop.current = true;
    };
  }, [refresh]);

  const setConsent = useCallback(
    async (accepted: boolean) => {
      const { db } = getFirebaseServices();
      await updateDoc(doc(db, "users", uid), {
        aiConsentAccepted: accepted,
        aiConsentAt: serverTimestamp(),
        aiConsentVersion: AI_CONSENT_VERSION,
        updatedAt: serverTimestamp(),
      });
      await refresh();
    },
    [uid, refresh],
  );

  const start = useCallback(async () => {
    stop.current = false;
    setState((previous) =>
      previous.name === "ready" ? { ...previous, running: true, error: null } : previous,
    );
    let job: JobView | null = null;
    try {
      job = await postJob("/api/jobs");
      while (job.status === "running" && !stop.current) {
        const current: JobView = job;
        setState((previous) => (previous.name === "ready" ? { ...previous, job: current } : previous));
        job = await postJob(`/api/jobs/${current.id}/advance`);
        if (job.status === "running" && job.waitMs > 0) await sleep(Math.min(job.waitMs, 60_000));
      }
      await refresh({ job, running: false });
    } catch (error) {
      await refresh({
        job,
        running: false,
        error: error instanceof Error ? error.message : "Analysis could not continue. Try again.",
      });
    }
  }, [refresh]);

  const halt = useCallback(() => {
    stop.current = true;
  }, []);

  return { state, start, halt, setConsent, refresh };
}

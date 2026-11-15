"use client";

import { collection, getCountFromServer, query, where, type DocumentSnapshot } from "firebase/firestore";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { useAuth } from "@/components/auth/auth-provider";
import { Button, buttonVariants } from "@/components/ui/button";
import type { ProjectView, TaskEdit, TaskView } from "@/lib/discoveries/model";
import { listProjects, listTasks, reviewTask } from "@/lib/discoveries/store";
import type { TaskStatus } from "@/lib/domain/discovery";
import { getFirebaseServices } from "@/lib/firebase/client";
import { cn } from "@/lib/utils";

import { TaskCard } from "./task-card";

const TABS: { status: TaskStatus; label: string; empty: string }[] = [
  {
    status: "awaiting_review",
    label: "To review",
    empty: "Nothing is waiting for you. New discoveries appear here after an analysis.",
  },
  { status: "approved", label: "Approved", empty: "You have not approved anything yet." },
  { status: "completed", label: "Done", empty: "Nothing is marked as done yet." },
  { status: "dismissed", label: "Dismissed", empty: "You have not dismissed anything." },
];

type Counts = Partial<Record<TaskStatus, number>>;

type View =
  | { name: "loading" }
  | { name: "error" }
  | { name: "ready"; tasks: TaskView[]; cursor: DocumentSnapshot | null; loadingMore: boolean };

type Notice = { text: string; undo: (() => Promise<void>) | null };

export function Inbox() {
  const auth = useAuth();
  const uid = auth.status === "signedIn" ? auth.user.uid : null;
  const [status, setStatus] = useState<TaskStatus>("awaiting_review");
  const [view, setView] = useState<View>({ name: "loading" });
  const [projects, setProjects] = useState<ProjectView[]>([]);
  const [counts, setCounts] = useState<Counts>({});
  const [notice, setNotice] = useState<Notice | null>(null);

  const loadCounts = useCallback(async (userId: string) => {
    const { db } = getFirebaseServices();
    const next: Counts = {};
    // One after another: a burst of requests competes with the SDK's streams.
    for (const tab of TABS) {
      const snapshot = await getCountFromServer(
        query(collection(db, "users", userId, "tasks"), where("status", "==", tab.status)),
      );
      next[tab.status] = snapshot.data().count;
    }
    setCounts(next);
  }, []);

  const load = useCallback(async (userId: string, which: TaskStatus) => {
    setView({ name: "loading" });
    try {
      const page = await listTasks(getFirebaseServices().db, userId, which);
      setView({ name: "ready", tasks: page.tasks, cursor: page.cursor, loadingMore: false });
    } catch {
      setView({ name: "error" });
    }
  }, []);

  useEffect(() => {
    if (!uid) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loads remote data when the tab changes
    void load(uid, status);
  }, [uid, status, load]);

  useEffect(() => {
    if (!uid) return;
    listProjects(getFirebaseServices().db, uid).then(setProjects, () => setProjects([]));
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loads remote counts on mount
    void loadCounts(uid).catch(() => {});
  }, [uid, loadCounts]);

  async function loadMore() {
    if (!uid || view.name !== "ready" || !view.cursor) return;
    setView({ ...view, loadingMore: true });
    try {
      const page = await listTasks(getFirebaseServices().db, uid, status, view.cursor);
      setView({ name: "ready", tasks: [...view.tasks, ...page.tasks], cursor: page.cursor, loadingMore: false });
    } catch {
      setView({ ...view, loadingMore: false });
    }
  }

  async function act(task: TaskView, edit: TaskEdit, label: string) {
    if (!uid) return;
    const { db } = getFirebaseServices();
    await reviewTask(db, uid, task.id, edit);

    const moved = edit.status !== undefined && edit.status !== task.status;
    setView((current) => {
      if (current.name !== "ready") return current;
      return {
        ...current,
        tasks: moved
          ? current.tasks.filter((entry) => entry.id !== task.id)
          : current.tasks.map((entry) =>
              entry.id === task.id
                ? {
                    ...entry,
                    title: edit.title?.trim() ?? entry.title,
                    description: edit.description?.trim() ?? entry.description,
                    priority: edit.priority ?? entry.priority,
                    projectId: edit.projectId !== undefined ? edit.projectId : entry.projectId,
                    remindOn: edit.remindOn !== undefined ? edit.remindOn : entry.remindOn,
                  }
                : entry,
            ),
      };
    });
    if (moved && edit.status) {
      const to = edit.status;
      setCounts((current) => ({
        ...current,
        [task.status]: Math.max(0, (current[task.status] ?? 1) - 1),
        [to]: (current[to] ?? 0) + 1,
      }));
    }
    setNotice({
      text: `${label}: ${task.title}`,
      undo: moved
        ? async () => {
            await reviewTask(db, uid, task.id, { status: task.status });
            setNotice(null);
            await Promise.all([load(uid, status), loadCounts(uid)]);
          }
        : null,
    });
  }

  return (
    <div className="flex flex-col gap-6">
      <div role="tablist" aria-label="Discoveries by status" className="flex flex-wrap gap-1 border-b">
        {TABS.map((tab) => (
          <button
            key={tab.status}
            type="button"
            role="tab"
            aria-selected={status === tab.status}
            onClick={() => {
              setNotice(null);
              setStatus(tab.status);
            }}
            className={cn(
              "-mb-px border-b-2 border-transparent px-3 py-2 text-sm text-muted-foreground transition-colors hover:text-foreground",
              status === tab.status && "border-foreground font-medium text-foreground",
            )}
          >
            {tab.label}
            {counts[tab.status] !== undefined ? (
              <span className="ml-1.5 text-xs text-muted-foreground tabular-nums">{counts[tab.status]}</span>
            ) : null}
          </button>
        ))}
      </div>

      {/* The live region stays mounted so screen readers announce changes; it takes no space when empty. */}
      <div aria-live="polite" className={notice ? undefined : "sr-only"}>
        {notice ? (
          <p className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted px-4 py-2.5 text-sm">
            <span className="min-w-0 truncate">{notice.text}</span>
            {notice.undo ? (
              <Button size="sm" variant="ghost" onClick={notice.undo}>
                Undo
              </Button>
            ) : null}
          </p>
        ) : null}
      </div>

      {view.name === "loading" ? (
        <div aria-busy="true" className="flex flex-col gap-3">
          <div className="h-32 animate-pulse rounded-lg bg-muted" />
          <div className="h-32 animate-pulse rounded-lg bg-muted" />
        </div>
      ) : view.name === "error" ? (
        <p role="alert" className="text-sm text-muted-foreground">
          Your discoveries could not be loaded. Check your connection and reload the page.
        </p>
      ) : view.tasks.length === 0 ? (
        <div className="flex flex-col items-start gap-3 rounded-lg border bg-card p-8">
          <p className="max-w-md text-sm leading-relaxed text-muted-foreground">
            {TABS.find((tab) => tab.status === status)?.empty}
          </p>
          {status === "awaiting_review" ? (
            <Link href="/dashboard" className={buttonVariants({ size: "sm", variant: "outline" })}>
              Go to analysis
            </Link>
          ) : null}
        </div>
      ) : (
        <>
          <ul className="flex flex-col gap-3">
            {view.tasks.map((task) => (
              <TaskCard key={task.id} task={task} projects={projects} onAction={act} />
            ))}
          </ul>
          {view.cursor ? (
            <div>
              <Button variant="outline" disabled={view.loadingMore} onClick={loadMore}>
                {view.loadingMore ? "Loading…" : "Show more"}
              </Button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

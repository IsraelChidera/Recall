"use client";

import { useCallback, useEffect, useState } from "react";

import { useAuth } from "@/components/auth/auth-provider";
import type { TaskEdit, TaskView } from "@/lib/discoveries/model";
import { loadWorkspace, reviewTask, type Workspace } from "@/lib/discoveries/store";
import { getFirebaseServices } from "@/lib/firebase/client";

export type WorkspaceState =
  | { name: "loading" }
  | { name: "error" }
  | { name: "ready"; workspace: Workspace; now: Date };

/** Loads the user's tasks and projects once, and reloads after each change. */
export function useWorkspace() {
  const auth = useAuth();
  const uid = auth.status === "signedIn" ? auth.user.uid : null;
  const [state, setState] = useState<WorkspaceState>({ name: "loading" });
  const [notice, setNotice] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!uid) return;
    try {
      const workspace = await loadWorkspace(getFirebaseServices().db, uid);
      setState({ name: "ready", workspace, now: new Date() });
    } catch {
      setState({ name: "error" });
    }
  }, [uid]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loads remote data on mount
    void reload();
  }, [reload]);

  const act = useCallback(
    async (task: TaskView, edit: TaskEdit, label: string) => {
      if (!uid) return;
      await reviewTask(getFirebaseServices().db, uid, task.id, edit);
      setNotice(`${label}: ${edit.title?.trim() || task.title}`);
      await reload();
    },
    [uid, reload],
  );

  return { state, act, notice, reload };
}

"use client";

import { FORGOTTEN, rankForgotten } from "@/lib/discoveries/insights";

import { EmptyState, LoadError, LoadingBlock, Notice, TruncatedNote } from "./shared";
import { TaskCard } from "./task-card";
import { useWorkspace } from "./use-workspace";

export function ForgottenWork() {
  const { state, act, notice } = useWorkspace();

  if (state.name === "loading") return <LoadingBlock />;
  if (state.name === "error") return <LoadError what="Your work" />;

  const { tasks, projects } = state.workspace;
  const items = rankForgotten(tasks, state.now);

  return (
    <div className="flex flex-col gap-6">
      <Notice text={notice} />
      <TruncatedNote show={state.workspace.truncated} />
      {items.length === 0 ? (
        <EmptyState>
          <p>
            Nothing looks forgotten. Recall lists work here when you clearly meant to do it and its
            conversation has been quiet for at least {FORGOTTEN.minDaysInactive} days.
          </p>
        </EmptyState>
      ) : (
        <>
          <ul className="flex flex-col gap-6">
            {items.map((item) => (
              <li key={item.task.id} className="flex flex-col gap-2">
                <p className="text-sm leading-relaxed text-muted-foreground">{item.reason}</p>
                <ul>
                  <TaskCard task={item.task} projects={projects} onAction={act} />
                </ul>
              </li>
            ))}
          </ul>
          <p className="text-xs leading-relaxed text-muted-foreground">
            Ranked by how firmly you committed, how long the conversation has been quiet and how sure
            Recall is. Something being old is not enough to appear here, and ideas you were only
            exploring never do.
          </p>
        </>
      )}
    </div>
  );
}

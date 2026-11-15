"use client";

import Link from "next/link";
import { useState } from "react";

import { buttonVariants } from "@/components/ui/button";
import { groupTasks, type Grouping } from "@/lib/discoveries/insights";
import { cn } from "@/lib/utils";

import { EmptyState, LoadError, LoadingBlock, Notice, TruncatedNote } from "./shared";
import { TaskCard } from "./task-card";
import { useWorkspace } from "./use-workspace";

const GROUPINGS: { value: Grouping; label: string }[] = [
  { value: "priority", label: "Priority" },
  { value: "project", label: "Project" },
  { value: "status", label: "Status" },
];

export function ExecutionInbox() {
  const { state, act, notice } = useWorkspace();
  const [grouping, setGrouping] = useState<Grouping>("priority");

  if (state.name === "loading") return <LoadingBlock />;
  if (state.name === "error") return <LoadError what="Your work" />;

  const { tasks, projects } = state.workspace;
  const active = tasks.filter((task) => task.status === "approved" || task.status === "in_progress");
  const groups = groupTasks(active, projects, grouping);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted-foreground">Organise by</span>
        <div role="group" aria-label="Organise by" className="flex rounded-md border bg-card p-0.5">
          {GROUPINGS.map((option) => (
            <button
              key={option.value}
              type="button"
              aria-pressed={grouping === option.value}
              onClick={() => setGrouping(option.value)}
              className={cn(
                "rounded px-3 py-1 text-sm text-muted-foreground transition-colors hover:text-foreground",
                grouping === option.value && "bg-accent font-medium text-foreground",
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      <Notice text={notice} />
      <TruncatedNote show={state.workspace.truncated} />

      {active.length === 0 ? (
        <EmptyState>
          <p>Nothing here yet. Work appears here once you approve it in the Inbox.</p>
          <Link href="/inbox" className={cn(buttonVariants({ size: "sm", variant: "outline" }), "mt-3")}>
            Go to the Inbox
          </Link>
        </EmptyState>
      ) : (
        groups.map((group) => (
          <section key={group.key} className="flex flex-col gap-3">
            <h2 className="text-sm font-semibold">
              {group.label} <span className="font-normal text-muted-foreground">({group.tasks.length})</span>
            </h2>
            <ul className="flex flex-col gap-3">
              {group.tasks.map((task) => (
                <TaskCard key={task.id} task={task} projects={projects} onAction={act} />
              ))}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}

"use client";

import Link from "next/link";
import { useState } from "react";

import { buildWeeklyReport, isoWeek, previousWeek } from "@/lib/discoveries/insights";
import type { TaskView } from "@/lib/discoveries/model";
import { cn } from "@/lib/utils";

import { EmptyState, LoadError, LoadingBlock, Section, TruncatedNote } from "./shared";
import { useWorkspace } from "./use-workspace";

const dayFormat = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

function TaskList({ tasks, empty }: { tasks: TaskView[]; empty: string }) {
  if (tasks.length === 0) return <p className="text-sm text-muted-foreground">{empty}</p>;
  return (
    <ul className="divide-y rounded-lg border bg-card">
      {tasks.map((task) => (
        <li key={task.id} className="flex items-baseline justify-between gap-4 px-4 py-3 text-sm">
          <span className="min-w-0">{task.title}</span>
          <span className="shrink-0 text-xs text-muted-foreground capitalize">{task.priority}</span>
        </li>
      ))}
    </ul>
  );
}

export function WeeklyIntelligence() {
  const { state } = useWorkspace();
  const [which, setWhich] = useState<"this" | "last">("this");

  if (state.name === "loading") return <LoadingBlock />;
  if (state.name === "error") return <LoadError what="Your weekly report" />;

  const { tasks, projects } = state.workspace;
  const current = isoWeek(state.now);
  const week = which === "this" ? current : previousWeek(current);
  // A past week is read as of its end, so staleness is not counted from today.
  const report = buildWeeklyReport(tasks, projects, week, which === "this" ? state.now : week.end);
  const lastDay = new Date(week.end.getTime() - 86_400_000);
  const nothing = tasks.length === 0;

  return (
    <div className="flex flex-col gap-10">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {dayFormat.format(week.start)} to {dayFormat.format(lastDay)} · {week.id}
        </p>
        <div role="group" aria-label="Week" className="flex rounded-md border bg-card p-0.5">
          {(["this", "last"] as const).map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={which === option}
              onClick={() => setWhich(option)}
              className={cn(
                "rounded px-3 py-1 text-sm text-muted-foreground transition-colors hover:text-foreground",
                which === option && "bg-accent font-medium text-foreground",
              )}
            >
              {option === "this" ? "This week" : "Last week"}
            </button>
          ))}
        </div>
      </div>

      {nothing ? (
        <EmptyState>
          <p>There is nothing to report yet. Import your conversations and run an analysis first.</p>
        </EmptyState>
      ) : (
        <>
          <TruncatedNote show={state.workspace.truncated} />
          <dl className="grid gap-px overflow-hidden rounded-lg border bg-border sm:grid-cols-4">
            {[
              ["Completed", report.completed.length],
              ["Taken on", report.takenOn.length],
              ["Outstanding", report.outstanding.total],
              ["In progress", report.outstanding.inProgress],
            ].map(([label, value]) => (
              <div key={label} className="flex flex-col gap-1 bg-card p-4">
                <dt className="text-xs text-muted-foreground">{label}</dt>
                <dd className="text-xl font-semibold tabular-nums">{value}</dd>
              </div>
            ))}
          </dl>

          <Section title="Suggested priorities">
            {report.suggestedPriorities.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Nothing approved to prioritise. <Link href="/inbox" className="underline underline-offset-4">Review your Inbox</Link>.
              </p>
            ) : (
              <ol className="flex flex-col gap-3">
                {report.suggestedPriorities.map((suggestion, index) => (
                  <li key={suggestion.task.id} className="flex gap-3 rounded-lg border bg-card p-4">
                    <span className="font-mono text-xs text-muted-foreground">{String(index + 1).padStart(2, "0")}</span>
                    <div className="flex min-w-0 flex-col gap-1">
                      <span className="text-sm font-medium">{suggestion.task.title}</span>
                      <span className="text-sm text-muted-foreground">{suggestion.why}</span>
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </Section>

          <Section title="Completed this week">
            <TaskList tasks={report.completed} empty="Nothing was marked as done in this week." />
          </Section>

          <Section title="Important commitments">
            <TaskList tasks={report.importantCommitments} empty="No open commitments are marked important." />
          </Section>

          <Section title="Projects needing attention">
            {report.projectsNeedingAttention.length === 0 ? (
              <p className="text-sm text-muted-foreground">No project with open work has gone quiet.</p>
            ) : (
              <ul className="divide-y rounded-lg border bg-card">
                {report.projectsNeedingAttention.map((entry) => (
                  <li key={entry.project.id} className="flex items-baseline justify-between gap-4 px-4 py-3 text-sm">
                    <Link href={`/projects/${entry.project.id}`} className="min-w-0 underline-offset-4 hover:underline">
                      {entry.project.name}
                    </Link>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {entry.open} open · quiet for {entry.daysQuiet} days
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section
            title="Forgotten intentions"
            aside={
              <Link href="/forgotten" className="text-xs text-muted-foreground underline-offset-4 hover:underline">
                See all
              </Link>
            }
          >
            {report.forgotten.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nothing looks forgotten.</p>
            ) : (
              <ul className="divide-y rounded-lg border bg-card">
                {report.forgotten.map((item) => (
                  <li key={item.task.id} className="flex flex-col gap-0.5 px-4 py-3">
                    <span className="text-sm">{item.task.title}</span>
                    <span className="text-xs text-muted-foreground">Quiet for {item.daysInactive} days</span>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <p className="text-xs leading-relaxed text-muted-foreground">
            This report is worked out from your tasks each time you open it. No AI request is made
            and nothing is sent anywhere.
          </p>
        </>
      )}
    </div>
  );
}

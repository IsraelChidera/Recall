"use client";

import Link from "next/link";

import { summariseDashboard } from "@/lib/discoveries/insights";
import type { TaskView } from "@/lib/discoveries/model";

import { LoadError, LoadingBlock, Section } from "./shared";
import { useWorkspace } from "./use-workspace";

const dateFormat = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium" });

function Titles({ tasks, detail }: { tasks: TaskView[]; detail?: (task: TaskView) => string }) {
  return (
    <ul className="divide-y rounded-lg border bg-card">
      {tasks.map((task) => (
        <li key={task.id} className="flex items-baseline justify-between gap-4 px-4 py-3 text-sm">
          <span className="min-w-0">{task.title}</span>
          {detail ? <span className="shrink-0 text-xs text-muted-foreground">{detail(task)}</span> : null}
        </li>
      ))}
    </ul>
  );
}

const more = "text-xs text-muted-foreground underline-offset-4 hover:underline";

/** The daily overview. Hidden entirely until there is something to show. */
export function DashboardSummary() {
  const { state } = useWorkspace();

  if (state.name === "loading") return <LoadingBlock />;
  if (state.name === "error") return <LoadError what="Your overview" />;

  const { tasks, projects } = state.workspace;
  if (tasks.length === 0) return null;
  const summary = summariseDashboard(tasks, projects, state.now);

  const attention = [
    summary.remindersDue.length > 0
      ? { href: "/execute", text: summary.remindersDue.length === 1 ? "1 reminder is due" : `${summary.remindersDue.length} reminders are due` }
      : null,
    summary.toReview > 0
      ? { href: "/inbox", text: summary.toReview === 1 ? "1 discovery is waiting for your review" : `${summary.toReview} discoveries are waiting for your review` }
      : null,
    summary.completionSuggested.length > 0
      ? { href: "/inbox", text: summary.completionSuggested.length === 1 ? "1 task may already be done" : `${summary.completionSuggested.length} tasks may already be done` }
      : null,
    summary.forgotten.length > 0
      ? { href: "/forgotten", text: summary.forgotten.length === 1 ? "1 commitment has gone quiet" : `${summary.forgotten.length} commitments have gone quiet` }
      : null,
  ].filter((entry): entry is { href: string; text: string } => entry !== null);

  return (
    <div className="flex flex-col gap-8">
      <dl className="grid gap-px overflow-hidden rounded-lg border bg-border sm:grid-cols-3">
        {[
          ["Done this week", summary.week.completed],
          ["Taken on this week", summary.week.approved],
          ["Open now", summary.week.open],
        ].map(([label, value]) => (
          <div key={label} className="flex flex-col gap-1 bg-card p-4">
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd className="text-xl font-semibold tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>

      <Section title="Needs your attention">
        {attention.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing needs you right now.</p>
        ) : (
          <ul className="divide-y rounded-lg border bg-card">
            {attention.map((entry) => (
              <li key={entry.text}>
                <Link href={entry.href} className="flex items-center justify-between gap-4 px-4 py-3 text-sm hover:bg-accent/50">
                  {entry.text}
                  <span aria-hidden="true" className="text-muted-foreground">→</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {summary.importantCommitments.length > 0 ? (
        <Section title="Important commitments" aside={<Link href="/execute" className={more}>All work</Link>}>
          <Titles
            tasks={summary.importantCommitments}
            detail={(task) => (task.status === "in_progress" ? "In progress" : `${task.priority} priority`)}
          />
        </Section>
      ) : null}

      {summary.upcomingReminders.length > 0 || summary.remindersDue.length > 0 ? (
        <Section title="Reminders">
          <Titles
            tasks={[...summary.remindersDue, ...summary.upcomingReminders]}
            detail={(task) => (task.remindOn ? dateFormat.format(task.remindOn) : "")}
          />
        </Section>
      ) : null}

      {summary.activeProjects.length > 0 ? (
        <Section title="Active projects" aside={<Link href="/projects" className={more}>All projects</Link>}>
          <ul className="divide-y rounded-lg border bg-card">
            {summary.activeProjects.map(({ project, open, inProgress }) => (
              <li key={project.id}>
                <Link href={`/projects/${project.id}`} className="flex items-baseline justify-between gap-4 px-4 py-3 text-sm hover:bg-accent/50">
                  <span className="min-w-0">{project.name}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {open} open{inProgress > 0 ? ` · ${inProgress} in progress` : ""}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {summary.recentlyDiscovered.length > 0 ? (
        <Section title="Recently discovered" aside={<Link href="/inbox" className={more}>Review</Link>}>
          <Titles tasks={summary.recentlyDiscovered} />
        </Section>
      ) : null}
    </div>
  );
}

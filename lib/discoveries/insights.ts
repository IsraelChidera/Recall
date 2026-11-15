import type { ProjectView, TaskView } from "./model";

/**
 * Everything the dashboard, Forgotten Work and the weekly report show is
 * computed here from tasks and projects, with no AI request. The functions
 * are pure: the same inputs and the same `now` always give the same result.
 */

const DAY = 86_400_000;

export const daysBetween = (from: Date, to: Date) => Math.floor((to.getTime() - from.getTime()) / DAY);

const OPEN_STATUSES = new Set(["awaiting_review", "approved", "in_progress"]);
export const isOpen = (task: TaskView) => OPEN_STATUSES.has(task.status);
const isActive = (task: TaskView) => task.status === "approved" || task.status === "in_progress";

// ---- Weeks -------------------------------------------------------------------

export type Week = { id: string; start: Date; end: Date };

/** The ISO week (Monday to Sunday, UTC) containing `date`, for example 2026-W46. */
export function isoWeek(date: Date): Week {
  const day = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const weekday = day.getUTCDay() || 7;
  const start = new Date(day.getTime() - (weekday - 1) * DAY);
  const thursday = new Date(start.getTime() + 3 * DAY);
  const yearStart = Date.UTC(thursday.getUTCFullYear(), 0, 1);
  const number = Math.floor((thursday.getTime() - yearStart) / (7 * DAY)) + 1;
  return {
    id: `${thursday.getUTCFullYear()}-W${String(number).padStart(2, "0")}`,
    start,
    end: new Date(start.getTime() + 7 * DAY),
  };
}

export const previousWeek = (week: Week): Week => isoWeek(new Date(week.start.getTime() - DAY));

const within = (date: Date | null, week: Week) =>
  date !== null && date.getTime() >= week.start.getTime() && date.getTime() < week.end.getTime();

// ---- Forgotten work ----------------------------------------------------------

/**
 * Commitment strength. Brainstorms and interests never become tasks, so they
 * cannot appear here at all; "uncertain" is deliberately too weak to qualify.
 */
const STRENGTH: Record<string, number> = {
  explicit_commitment: 1,
  active_execution: 0.85,
  intention: 0.55,
  uncertain: 0.2,
};

export const FORGOTTEN = {
  /** Quiet for at least this long before anything is called forgotten. */
  minDaysInactive: 21,
  /** Age alone is not enough: the score must clear this bar too. */
  minScore: 0.3,
  /** Staleness stops adding weight after this many days. */
  saturationDays: 180,
} as const;

export type ForgottenItem = {
  task: TaskView;
  daysInactive: number;
  score: number;
  reason: string;
};

function forgottenReason(task: TaskView, days: number): string {
  const said =
    task.commitmentClass === "explicit_commitment"
      ? "You said you would do this"
      : task.commitmentClass === "active_execution"
        ? "You were working on this"
        : "You said you wanted to do this";
  const state =
    task.status === "in_progress"
      ? "It is marked as in progress."
      : task.status === "approved"
        ? "You approved it, and it is still open."
        : "You have not reviewed it yet.";
  return `${said}, and the conversation has been quiet for ${days} days. ${state}`;
}

/**
 * How much an open task looks forgotten, from 0 to 1. It combines how firmly
 * the user committed, how long the conversation has been quiet, how sure
 * Recall is, and whether the user had already taken it on. Old age by itself
 * never qualifies a task.
 */
export function forgottenScore(task: TaskView, now: Date): { score: number; daysInactive: number } | null {
  if (!isOpen(task)) return null;
  const last = task.lastActivityAt ?? task.originalAt ?? task.discoveredAt;
  if (!last) return null;
  const daysInactive = daysBetween(last, now);
  if (daysInactive < FORGOTTEN.minDaysInactive) return null;

  const strength = STRENGTH[task.commitmentClass] ?? STRENGTH.uncertain!;
  const staleness = Math.min(1, Math.log1p(daysInactive) / Math.log1p(FORGOTTEN.saturationDays));
  const confidence = Math.max(0.3, Math.min(1, task.confidence || 0.5));
  const taken = task.status === "in_progress" ? 1.15 : task.status === "approved" ? 1.1 : 1;
  const corroborated = 1 + Math.min(0.15, 0.05 * Math.max(0, task.sourceConversationIds.length - 1));
  const score = Math.min(1, strength * staleness * confidence * taken * corroborated);
  return { score: Math.round(score * 100) / 100, daysInactive };
}

export function rankForgotten(tasks: TaskView[], now: Date): ForgottenItem[] {
  const items: ForgottenItem[] = [];
  for (const task of tasks) {
    const scored = forgottenScore(task, now);
    if (!scored || scored.score < FORGOTTEN.minScore) continue;
    items.push({ task, ...scored, reason: forgottenReason(task, scored.daysInactive) });
  }
  return items.sort((a, b) => b.score - a.score || b.daysInactive - a.daysInactive);
}

// ---- Priorities --------------------------------------------------------------

export type Suggestion = { task: TaskView; why: string };

/**
 * What to do next, most pressing first: reminders that are due, then high
 * priority work in progress, then high priority, then firm commitments going
 * stale. Every suggestion says why it was chosen.
 */
export function suggestPriorities(tasks: TaskView[], now: Date, max = 3): Suggestion[] {
  const ranked = tasks
    .filter(isActive)
    .map((task) => {
      const reminderDue = task.remindOn !== null && task.remindOn.getTime() <= now.getTime() + DAY;
      const stale = forgottenScore(task, now);
      const rank =
        (reminderDue ? 100 : 0) +
        (task.status === "in_progress" ? 20 : 0) +
        (task.priority === "high" ? 40 : task.priority === "medium" ? 10 : 0) +
        (stale ? stale.score * 15 : 0);
      const why = reminderDue
        ? "You asked to be reminded about this."
        : task.status === "in_progress" && task.priority === "high"
          ? "High priority, and you have already started."
          : task.priority === "high"
            ? "You marked this high priority."
            : task.status === "in_progress"
              ? "You have already started this."
              : stale
                ? `Open for ${stale.daysInactive} days since you last discussed it.`
                : "Approved and waiting.";
      return { task, why, rank };
    })
    .sort((a, b) => b.rank - a.rank || a.task.title.localeCompare(b.task.title));
  return ranked.slice(0, max).map(({ task, why }) => ({ task, why }));
}

// ---- Dashboard ---------------------------------------------------------------

export type ProjectSummary = { project: ProjectView; open: number; inProgress: number };

export type DashboardSummary = {
  toReview: number;
  completionSuggested: TaskView[];
  remindersDue: TaskView[];
  upcomingReminders: TaskView[];
  importantCommitments: TaskView[];
  recentlyDiscovered: TaskView[];
  activeProjects: ProjectSummary[];
  forgotten: ForgottenItem[];
  week: { id: string; completed: number; approved: number; open: number };
};

const byNewest = (a: TaskView, b: TaskView) =>
  (b.discoveredAt?.getTime() ?? 0) - (a.discoveredAt?.getTime() ?? 0);

export function summariseDashboard(tasks: TaskView[], projects: ProjectView[], now: Date): DashboardSummary {
  const week = isoWeek(now);
  const active = tasks.filter(isActive);
  const awaiting = tasks.filter((task) => task.status === "awaiting_review");
  const withReminder = active.filter((task) => task.remindOn !== null);
  const soon = now.getTime() + 14 * DAY;

  const projectSummaries = projects
    .filter((project) => !project.archived)
    .map((project) => {
      const mine = active.filter((task) => task.projectId === project.id);
      return {
        project,
        open: mine.length,
        inProgress: mine.filter((task) => task.status === "in_progress").length,
      };
    })
    .filter((summary) => summary.open > 0)
    .sort((a, b) => b.inProgress - a.inProgress || b.open - a.open)
    .slice(0, 5);

  return {
    toReview: awaiting.length,
    completionSuggested: tasks.filter((task) => isOpen(task) && task.completionSuggested).slice(0, 5),
    remindersDue: withReminder
      .filter((task) => task.remindOn!.getTime() <= now.getTime())
      .sort((a, b) => a.remindOn!.getTime() - b.remindOn!.getTime()),
    upcomingReminders: withReminder
      .filter((task) => task.remindOn!.getTime() > now.getTime() && task.remindOn!.getTime() <= soon)
      .sort((a, b) => a.remindOn!.getTime() - b.remindOn!.getTime())
      .slice(0, 5),
    importantCommitments: active
      .filter((task) => task.priority === "high" || task.commitmentClass === "explicit_commitment")
      .sort(
        (a, b) =>
          Number(b.priority === "high") - Number(a.priority === "high") ||
          Number(b.status === "in_progress") - Number(a.status === "in_progress") ||
          a.title.localeCompare(b.title),
      )
      .slice(0, 5),
    recentlyDiscovered: [...awaiting].sort(byNewest).slice(0, 5),
    activeProjects: projectSummaries,
    forgotten: rankForgotten(active, now).slice(0, 3),
    week: {
      id: week.id,
      completed: tasks.filter((task) => task.status === "completed" && within(task.lastReviewedAt, week)).length,
      approved: active.filter((task) => within(task.lastReviewedAt, week)).length,
      open: active.length,
    },
  };
}

// ---- Weekly report -----------------------------------------------------------

export type WeeklyReport = {
  week: Week;
  /** Finished by the user's own action during the week. */
  completed: TaskView[];
  /** Approved or started during the week and still open. */
  takenOn: TaskView[];
  importantCommitments: TaskView[];
  outstanding: { total: number; inProgress: number; highPriority: number };
  projectsNeedingAttention: { project: ProjectView; open: number; daysQuiet: number }[];
  forgotten: ForgottenItem[];
  suggestedPriorities: Suggestion[];
};

/**
 * The weekly report. `now` decides staleness and priorities; for a past week
 * pass the end of that week so the report reads as it would have then.
 */
export function buildWeeklyReport(
  tasks: TaskView[],
  projects: ProjectView[],
  week: Week,
  now: Date,
): WeeklyReport {
  const active = tasks.filter(isActive);
  const attention = projects
    .filter((project) => !project.archived && project.lastActivityAt !== null)
    .map((project) => ({
      project,
      open: active.filter((task) => task.projectId === project.id).length,
      daysQuiet: daysBetween(project.lastActivityAt!, now),
    }))
    .filter((entry) => entry.open > 0 && entry.daysQuiet >= FORGOTTEN.minDaysInactive)
    .sort((a, b) => b.open - a.open || b.daysQuiet - a.daysQuiet)
    .slice(0, 5);

  return {
    week,
    completed: tasks.filter((task) => task.status === "completed" && within(task.lastReviewedAt, week)),
    takenOn: active.filter((task) => within(task.lastReviewedAt, week)),
    importantCommitments: active
      .filter((task) => task.priority === "high" || task.commitmentClass === "explicit_commitment")
      .sort((a, b) => Number(b.priority === "high") - Number(a.priority === "high") || a.title.localeCompare(b.title))
      .slice(0, 8),
    outstanding: {
      total: active.length,
      inProgress: active.filter((task) => task.status === "in_progress").length,
      highPriority: active.filter((task) => task.priority === "high").length,
    },
    projectsNeedingAttention: attention,
    forgotten: rankForgotten(tasks.filter(isOpen), now).slice(0, 5),
    suggestedPriorities: suggestPriorities(tasks, now),
  };
}

// ---- Execution groups --------------------------------------------------------

export type Grouping = "priority" | "project" | "status";
export type TaskGroup = { key: string; label: string; tasks: TaskView[] };

const PRIORITY_ORDER = ["high", "medium", "low"] as const;
const PRIORITY_NAMES = { high: "High priority", medium: "Medium priority", low: "Low priority" } as const;

export function groupTasks(tasks: TaskView[], projects: ProjectView[], grouping: Grouping): TaskGroup[] {
  const sorted = [...tasks].sort(
    (a, b) =>
      PRIORITY_ORDER.indexOf(a.priority) - PRIORITY_ORDER.indexOf(b.priority) ||
      Number(b.status === "in_progress") - Number(a.status === "in_progress") ||
      a.title.localeCompare(b.title),
  );
  if (grouping === "priority") {
    return PRIORITY_ORDER.map((priority) => ({
      key: priority,
      label: PRIORITY_NAMES[priority],
      tasks: sorted.filter((task) => task.priority === priority),
    })).filter((group) => group.tasks.length > 0);
  }
  if (grouping === "status") {
    return [
      { key: "in_progress", label: "In progress", tasks: sorted.filter((task) => task.status === "in_progress") },
      { key: "approved", label: "Not started", tasks: sorted.filter((task) => task.status === "approved") },
    ].filter((group) => group.tasks.length > 0);
  }
  const names = new Map(projects.map((project) => [project.id, project.name]));
  const groups = new Map<string, TaskGroup>();
  for (const task of sorted) {
    const known = task.projectId !== null && names.has(task.projectId);
    const key = known ? task.projectId! : "";
    const group = groups.get(key) ?? { key, label: known ? names.get(key)! : "No project", tasks: [] };
    group.tasks.push(task);
    groups.set(key, group);
  }
  return [...groups.values()].sort(
    (a, b) => Number(a.key === "") - Number(b.key === "") || a.label.localeCompare(b.label),
  );
}

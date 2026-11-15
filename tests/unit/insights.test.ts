import { describe, expect, it } from "vitest";

import {
  buildWeeklyReport,
  FORGOTTEN,
  forgottenScore,
  groupTasks,
  isoWeek,
  previousWeek,
  rankForgotten,
  suggestPriorities,
  summariseDashboard,
} from "@/lib/discoveries/insights";
import { toProjectView, toTaskView, type ProjectView, type TaskView } from "@/lib/discoveries/model";

const NOW = new Date("2026-11-13T12:00:00Z"); // a Friday in 2026-W46
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000);

let counter = 0;
function task(overrides: Partial<TaskView> = {}): TaskView {
  counter++;
  return {
    ...toTaskView(`t${counter}`, {
      title: `Task ${counter}`,
      status: "approved",
      priority: "medium",
      confidence: 0.85,
      commitmentClass: "explicit_commitment",
      sourceConversationIds: ["claude_c1"],
    }),
    lastActivityAt: daysAgo(60),
    ...overrides,
  };
}

const project = (id: string, overrides: Partial<ProjectView> = {}): ProjectView => ({
  ...toProjectView(id, { name: `Project ${id}` }),
  lastActivityAt: daysAgo(40),
  ...overrides,
});

describe("isoWeek", () => {
  it("names the week and runs Monday to Monday in UTC", () => {
    const week = isoWeek(NOW);
    expect(week.id).toBe("2026-W46");
    expect(week.start.toISOString()).toBe("2026-11-09T00:00:00.000Z");
    expect(week.end.toISOString()).toBe("2026-11-16T00:00:00.000Z");
  });

  it("handles year boundaries the ISO way", () => {
    expect(isoWeek(new Date("2027-01-01T00:00:00Z")).id).toBe("2026-W53");
    expect(isoWeek(new Date("2026-01-01T00:00:00Z")).id).toBe("2026-W01");
    expect(isoWeek(new Date("2024-12-30T00:00:00Z")).id).toBe("2025-W01");
  });

  it("puts Sunday in the week that started the previous Monday", () => {
    expect(isoWeek(new Date("2026-11-15T23:59:59Z")).id).toBe("2026-W46");
    expect(isoWeek(new Date("2026-11-16T00:00:00Z")).id).toBe("2026-W47");
  });

  it("steps back one week", () => {
    expect(previousWeek(isoWeek(NOW)).id).toBe("2026-W45");
  });
});

describe("forgotten work", () => {
  it("does not call something forgotten just because it is old", () => {
    const vague = task({ commitmentClass: "uncertain", lastActivityAt: daysAgo(400), confidence: 0.4 });
    expect(rankForgotten([vague], NOW)).toEqual([]);
  });

  it("ignores recent work however firm the commitment", () => {
    expect(forgottenScore(task({ lastActivityAt: daysAgo(FORGOTTEN.minDaysInactive - 1) }), NOW)).toBeNull();
    expect(forgottenScore(task({ lastActivityAt: daysAgo(FORGOTTEN.minDaysInactive) }), NOW)).not.toBeNull();
  });

  it("ignores finished and dismissed work", () => {
    expect(forgottenScore(task({ status: "completed" }), NOW)).toBeNull();
    expect(forgottenScore(task({ status: "dismissed" }), NOW)).toBeNull();
  });

  it("ranks a firm commitment above a loose intention of the same age", () => {
    const firm = task({ commitmentClass: "explicit_commitment" });
    const loose = task({ commitmentClass: "intention" });
    const [first, second] = rankForgotten([loose, firm], NOW);
    expect(first!.task.id).toBe(firm.id);
    expect(second!.task.id).toBe(loose.id);
    expect(first!.score).toBeGreaterThan(second!.score);
  });

  it("weighs staleness, but stops adding weight eventually", () => {
    const month = forgottenScore(task({ lastActivityAt: daysAgo(30) }), NOW)!.score;
    const quarter = forgottenScore(task({ lastActivityAt: daysAgo(90) }), NOW)!.score;
    const year = forgottenScore(task({ lastActivityAt: daysAgo(365) }), NOW)!.score;
    const twoYears = forgottenScore(task({ lastActivityAt: daysAgo(730) }), NOW)!.score;
    expect(quarter).toBeGreaterThan(month);
    expect(year).toBeGreaterThan(quarter);
    expect(twoYears).toBe(year);
    expect(year).toBeLessThanOrEqual(1);
  });

  it("ranks work the user took on above work never reviewed", () => {
    const approved = forgottenScore(task({ status: "approved" }), NOW)!.score;
    const unreviewed = forgottenScore(task({ status: "awaiting_review" }), NOW)!.score;
    expect(approved).toBeGreaterThan(unreviewed);
  });

  it("explains itself in plain words", () => {
    const [item] = rankForgotten([task({ status: "in_progress", lastActivityAt: daysAgo(75) })], NOW);
    expect(item!.reason).toBe(
      "You said you would do this, and the conversation has been quiet for 75 days. It is marked as in progress.",
    );
  });

  it("has nothing to say without any date", () => {
    expect(forgottenScore(task({ lastActivityAt: null, originalAt: null, discoveredAt: null }), NOW)).toBeNull();
  });
});

describe("suggestPriorities", () => {
  it("puts a due reminder first, then started high-priority work, and says why", () => {
    const reminder = task({ title: "Reminder", priority: "low", remindOn: daysAgo(1), lastActivityAt: daysAgo(2) });
    const started = task({ title: "Started", priority: "high", status: "in_progress", lastActivityAt: daysAgo(2) });
    const high = task({ title: "High", priority: "high", lastActivityAt: daysAgo(2) });
    const plain = task({ title: "Plain", lastActivityAt: daysAgo(2) });
    const picks = suggestPriorities([plain, high, started, reminder], NOW);
    expect(picks.map((pick) => pick.task.title)).toEqual(["Reminder", "Started", "High"]);
    expect(picks[0]!.why).toMatch(/reminded/);
    expect(picks[1]!.why).toMatch(/already started/);
  });

  it("never suggests work that is unapproved, done or dismissed", () => {
    const picks = suggestPriorities(
      [task({ status: "awaiting_review" }), task({ status: "completed" }), task({ status: "dismissed" })],
      NOW,
    );
    expect(picks).toEqual([]);
  });

  it("breaks ties the same way every time", () => {
    const a = task({ title: "Alpha", lastActivityAt: daysAgo(2) });
    const b = task({ title: "Beta", lastActivityAt: daysAgo(2) });
    expect(suggestPriorities([b, a], NOW).map((pick) => pick.task.title)).toEqual(["Alpha", "Beta"]);
  });
});

describe("summariseDashboard", () => {
  it("counts the week's progress from the user's own decisions", () => {
    const summary = summariseDashboard(
      [
        task({ status: "completed", lastReviewedAt: daysAgo(1) }),
        task({ status: "completed", lastReviewedAt: daysAgo(20) }),
        // Recorded as done by analysis, not by the user this week.
        task({ status: "completed", lastReviewedAt: null }),
        task({ status: "approved", lastReviewedAt: daysAgo(2) }),
        task({ status: "in_progress", lastReviewedAt: daysAgo(30) }),
        task({ status: "awaiting_review" }),
      ],
      [],
      NOW,
    );
    expect(summary.week).toEqual({ id: "2026-W46", completed: 1, approved: 1, open: 2 });
    expect(summary.toReview).toBe(1);
  });

  it("separates reminders that are due from those coming up, and ignores far ones", () => {
    const due = task({ remindOn: daysAgo(1) });
    const soon = task({ remindOn: daysAgo(-3) });
    const far = task({ remindOn: daysAgo(-40) });
    const unapproved = task({ status: "awaiting_review", remindOn: daysAgo(1) });
    const summary = summariseDashboard([due, soon, far, unapproved], [], NOW);
    expect(summary.remindersDue.map((entry) => entry.id)).toEqual([due.id]);
    expect(summary.upcomingReminders.map((entry) => entry.id)).toEqual([soon.id]);
  });

  it("lists active projects by work in progress, skipping archived and idle ones", () => {
    const busy = project("busy");
    const quiet = project("quiet");
    const archived = project("archived", { archived: true });
    const idle = project("idle");
    const summary = summariseDashboard(
      [
        task({ projectId: "quiet" }),
        task({ projectId: "busy", status: "in_progress" }),
        task({ projectId: "busy" }),
        task({ projectId: "archived" }),
        task({ projectId: "idle", status: "completed" }),
      ],
      [quiet, archived, idle, busy],
      NOW,
    );
    expect(summary.activeProjects.map((entry) => [entry.project.id, entry.open, entry.inProgress])).toEqual([
      ["busy", 2, 1],
      ["quiet", 1, 0],
    ]);
  });

  it("flags open tasks that a later message suggests are done", () => {
    const flagged = task({ completionSuggested: true });
    const summary = summariseDashboard([flagged, task({ status: "completed", completionSuggested: true })], [], NOW);
    expect(summary.completionSuggested.map((entry) => entry.id)).toEqual([flagged.id]);
  });

  it("caps every list", () => {
    const many = Array.from({ length: 20 }, () => task({ priority: "high" }));
    const summary = summariseDashboard(many, [], NOW);
    expect(summary.importantCommitments).toHaveLength(5);
    expect(summary.forgotten).toHaveLength(3);
  });
});

describe("buildWeeklyReport", () => {
  const week = isoWeek(NOW);

  it("reports the week's completed and taken-on work and the outstanding totals", () => {
    const report = buildWeeklyReport(
      [
        task({ title: "Done now", status: "completed", lastReviewedAt: daysAgo(2) }),
        task({ title: "Done before", status: "completed", lastReviewedAt: daysAgo(9) }),
        task({ title: "Taken on", status: "approved", lastReviewedAt: daysAgo(1), priority: "high" }),
        task({ title: "Older", status: "in_progress", lastReviewedAt: daysAgo(15) }),
      ],
      [],
      week,
      NOW,
    );
    expect(report.completed.map((entry) => entry.title)).toEqual(["Done now"]);
    expect(report.takenOn.map((entry) => entry.title)).toEqual(["Taken on"]);
    expect(report.outstanding).toEqual({ total: 2, inProgress: 1, highPriority: 1 });
    expect(report.suggestedPriorities[0]!.task.title).toBe("Taken on");
  });

  it("reads last week from last week's point of view", () => {
    const last = previousWeek(week);
    const report = buildWeeklyReport(
      [task({ title: "Done last week", status: "completed", lastReviewedAt: daysAgo(8) })],
      [],
      last,
      last.end,
    );
    expect(report.week.id).toBe("2026-W45");
    expect(report.completed.map((entry) => entry.title)).toEqual(["Done last week"]);
  });

  it("names projects with open work that have gone quiet, and no others", () => {
    const quiet = project("quiet", { lastActivityAt: daysAgo(50) });
    const fresh = project("fresh", { lastActivityAt: daysAgo(3) });
    const empty = project("empty", { lastActivityAt: daysAgo(200) });
    const report = buildWeeklyReport(
      [task({ projectId: "quiet" }), task({ projectId: "fresh" }), task({ projectId: "empty", status: "completed" })],
      [fresh, empty, quiet],
      week,
      NOW,
    );
    expect(report.projectsNeedingAttention).toEqual([{ project: quiet, open: 1, daysQuiet: 50 }]);
  });
});

describe("groupTasks", () => {
  const projects = [project("b", { name: "Beta" }), project("a", { name: "Alpha" })];
  const tasks = [
    task({ title: "Low", priority: "low", projectId: "b" }),
    task({ title: "High started", priority: "high", status: "in_progress", projectId: "a" }),
    task({ title: "High", priority: "high" }),
    task({ title: "Orphan", priority: "medium", projectId: "deleted-project" }),
  ];

  it("groups by priority, highest first, started work first within a group", () => {
    const groups = groupTasks(tasks, projects, "priority");
    expect(groups.map((group) => group.label)).toEqual(["High priority", "Medium priority", "Low priority"]);
    expect(groups[0]!.tasks.map((entry) => entry.title)).toEqual(["High started", "High"]);
  });

  it("groups by project by name, with unassigned and unknown projects last", () => {
    const groups = groupTasks(tasks, projects, "project");
    expect(groups.map((group) => group.label)).toEqual(["Alpha", "Beta", "No project"]);
    expect(groups[2]!.tasks.map((entry) => entry.title)).toEqual(["High", "Orphan"]);
  });

  it("groups by status and omits empty groups", () => {
    expect(groupTasks(tasks, projects, "status").map((group) => [group.label, group.tasks.length])).toEqual([
      ["In progress", 1],
      ["Not started", 3],
    ]);
    expect(groupTasks([], projects, "status")).toEqual([]);
  });
});

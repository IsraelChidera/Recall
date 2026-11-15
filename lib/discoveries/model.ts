import {
  PRIORITIES,
  PRIORITY_RANK,
  TASK_STATUSES,
  type Priority,
  type TaskStatus,
} from "@/lib/domain/discovery";

/**
 * What the review screens show. Firestore documents are read defensively:
 * a missing or odd field becomes a safe default, never a crash.
 */
export type EvidenceView = {
  kind: "commitment" | "completion";
  conversationId: string;
  messageAt: Date | null;
  quote: string;
};

export type TaskView = {
  id: string;
  title: string;
  description: string;
  category: string;
  /** How strongly the user bound themselves: intention, explicit_commitment, ... */
  commitmentClass: string;
  status: TaskStatus;
  priority: Priority;
  confidence: number;
  needsAttention: boolean;
  completionSuggested: boolean;
  suggestedNextAction: string;
  dueDate: string | null;
  projectId: string | null;
  evidence: EvidenceView[];
  sourceConversationIds: string[];
  originalAt: Date | null;
  discoveredAt: Date | null;
  /** When the source conversation was last active. */
  lastActivityAt: Date | null;
  /** When the user last made a decision about this task. */
  lastReviewedAt: Date | null;
  remindOn: Date | null;
};

export type DecisionView = { text: string; quote: string; conversationId: string };

export type ProjectView = {
  id: string;
  name: string;
  description: string;
  archived: boolean;
  conversationIds: string[];
  decisions: DecisionView[];
  lastActivityAt: Date | null;
};

const text = (value: unknown) => (typeof value === "string" ? value : "");

export function toDate(value: unknown): Date | null {
  if (value instanceof Date) return value;
  if (typeof value === "string") {
    const time = Date.parse(value);
    return Number.isNaN(time) ? null : new Date(time);
  }
  if (typeof value === "object" && value !== null && "toDate" in value && typeof value.toDate === "function") {
    return value.toDate() as Date;
  }
  return null;
}

const strings = (value: unknown) =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];

export function toTaskView(id: string, data: Record<string, unknown>): TaskView {
  const status = TASK_STATUSES.find((candidate) => candidate === data.status) ?? "awaiting_review";
  const priority = PRIORITIES.find((candidate) => candidate === data.priority) ?? "medium";
  const evidence = Array.isArray(data.evidence) ? (data.evidence as Record<string, unknown>[]) : [];
  return {
    id,
    title: text(data.title) || "Untitled",
    description: text(data.description),
    category: text(data.category),
    commitmentClass: text(data.commitmentClass),
    status,
    priority,
    confidence: typeof data.confidence === "number" ? data.confidence : 0,
    needsAttention: data.needsAttention === true,
    completionSuggested: data.completionSuggested === true,
    suggestedNextAction: text(data.suggestedNextAction),
    dueDate: text(data.dueDate) || null,
    projectId: text(data.projectId) || null,
    evidence: evidence
      .filter((entry) => typeof entry === "object" && entry !== null && text(entry.quote).length > 0)
      .map((entry) => ({
        kind: entry.kind === "completion" ? "completion" : "commitment",
        conversationId: text(entry.conversationId),
        messageAt: toDate(entry.messageAt),
        quote: text(entry.quote),
      })),
    sourceConversationIds: strings(data.sourceConversationIds),
    originalAt: toDate(data.originalAt),
    discoveredAt: toDate(data.discoveredAt),
    lastActivityAt: toDate(data.lastActivityAt),
    lastReviewedAt: toDate(data.lastReviewedAt),
    remindOn: toDate(data.remindOn),
  };
}

export function toProjectView(id: string, data: Record<string, unknown>): ProjectView {
  const decisions = Array.isArray(data.decisions) ? (data.decisions as Record<string, unknown>[]) : [];
  return {
    id,
    name: text(data.name) || "Untitled project",
    description: text(data.description),
    archived: data.archived === true,
    conversationIds: strings(data.conversationIds),
    decisions: decisions
      .filter((entry) => typeof entry === "object" && entry !== null && text(entry.text).length > 0)
      .map((entry) => ({
        text: text(entry.text),
        quote: text(entry.quote),
        conversationId: text(entry.conversationId),
      })),
    lastActivityAt: toDate(data.lastActivityAt),
  };
}

export const CATEGORY_LABELS: Record<string, string> = {
  unfinished_project: "Unfinished project",
  explicit_commitment: "Commitment",
  pending_action: "Pending action",
  unfinished_deliverable: "Unfinished deliverable",
  future_intention: "Intention",
  follow_up: "Follow-up",
  abandoned_conversation: "Left unfinished",
};

export const PRIORITY_LABELS: Record<Priority, string> = { low: "Low", medium: "Medium", high: "High" };

/**
 * A link back to the original chat, where the source has a stable URL.
 * Conversation ids are `<source>_<source id>`; only Claude is known today.
 */
export function sourceUrlFor(conversationId: string): string | null {
  const match = /^claude_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(conversationId);
  return match ? `https://claude.ai/chat/${match[1]}` : null;
}

export const TITLE_MAX = 300;
export const DESCRIPTION_MAX = 4_000;
export const PROJECT_NAME_MAX = 200;
export const PROJECT_DESCRIPTION_MAX = 2_000;

export type TaskEdit = {
  title?: string;
  description?: string;
  priority?: Priority;
  projectId?: string | null;
  status?: TaskStatus;
  /** A date to be reminded on, or null to clear it. */
  remindOn?: Date | null;
};

export class InvalidEditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidEditError";
  }
}

/**
 * Turns an edit into the exact fields the security rules let a user change.
 * Validation here mirrors `validTaskReview` in firestore.rules, so a bad edit
 * is explained to the user instead of being refused by the server.
 */
export function taskPatch(edit: TaskEdit): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (edit.title !== undefined) {
    const title = edit.title.trim();
    if (title.length === 0) throw new InvalidEditError("Give the task a title.");
    if (title.length > TITLE_MAX) throw new InvalidEditError(`Keep the title under ${TITLE_MAX} characters.`);
    patch.title = title;
  }
  if (edit.description !== undefined) {
    const description = edit.description.trim();
    if (description.length > DESCRIPTION_MAX) {
      throw new InvalidEditError(`Keep the description under ${DESCRIPTION_MAX} characters.`);
    }
    patch.description = description;
  }
  if (edit.priority !== undefined) {
    if (!PRIORITIES.includes(edit.priority)) throw new InvalidEditError("Unknown priority.");
    patch.priority = edit.priority;
    patch.priorityRank = PRIORITY_RANK[edit.priority];
  }
  if (edit.projectId !== undefined) patch.projectId = edit.projectId;
  if (edit.remindOn !== undefined) {
    if (edit.remindOn !== null && Number.isNaN(edit.remindOn.getTime())) {
      throw new InvalidEditError("That reminder date is not valid.");
    }
    patch.remindOn = edit.remindOn;
  }
  if (edit.status !== undefined) {
    if (!TASK_STATUSES.includes(edit.status)) throw new InvalidEditError("Unknown status.");
    patch.status = edit.status;
  }
  if (Object.keys(patch).length === 0) throw new InvalidEditError("Nothing to change.");
  return patch;
}

export function projectPatch(edit: { name?: string; description?: string; archived?: boolean }): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (edit.name !== undefined) {
    const name = edit.name.trim();
    if (name.length === 0) throw new InvalidEditError("Give the project a name.");
    if (name.length > PROJECT_NAME_MAX) throw new InvalidEditError(`Keep the name under ${PROJECT_NAME_MAX} characters.`);
    patch.name = name;
  }
  if (edit.description !== undefined) {
    const description = edit.description.trim();
    if (description.length > PROJECT_DESCRIPTION_MAX) {
      throw new InvalidEditError(`Keep the description under ${PROJECT_DESCRIPTION_MAX} characters.`);
    }
    patch.description = description;
  }
  if (edit.archived !== undefined) patch.archived = edit.archived;
  if (Object.keys(patch).length === 0) throw new InvalidEditError("Nothing to change.");
  return patch;
}

const ACTIVITY_FOR_STATUS: Partial<Record<TaskStatus, string>> = {
  approved: "task_approved",
  dismissed: "task_dismissed",
  completed: "task_completed",
};

/** The activity log entry type for an edit; status changes take precedence. */
export function activityTypeFor(edit: TaskEdit): string {
  return (edit.status && ACTIVITY_FOR_STATUS[edit.status]) ?? "task_edited";
}

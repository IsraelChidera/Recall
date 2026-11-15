import type { DecisionView, TaskView } from "@/lib/discoveries/model";
import { redact } from "@/lib/ai/redact";
import type { StoredMessage } from "@/lib/import/plan";

/**
 * The context needed to pick a piece of work back up, gathered from the
 * stored conversation. Everything here is copied from the user's own data.
 * Nothing is summarised, inferred or generated. Secrets, email addresses and
 * long numbers are replaced with placeholders, because the result is meant to
 * be pasted somewhere else.
 */
export type ContextMessage = {
  id: string;
  sender: "human" | "assistant";
  createdAt: string | null;
  /** The stored text, shortened with a visible marker when long. */
  text: string;
  /** True for the message the commitment was found in. */
  isEvidence: boolean;
};

export type ResumeConversation = {
  id: string;
  title: string;
  sourceUrl: string | null;
};

export type ResumeContext = {
  task: Pick<TaskView, "id" | "title" | "description" | "suggestedNextAction" | "dueDate" | "status">;
  conversation: ResumeConversation | null;
  /** The user's own words that the task was found in. */
  commitment: { quote: string; saidAt: Date | null } | null;
  /** The messages around the commitment, in order. */
  around: ContextMessage[];
  /** The last messages of the conversation that are not already in `around`. */
  ending: ContextMessage[];
  /** Decisions recorded for the task's project, each with the words they came from. */
  decisions: DecisionView[];
  /** How many messages the stored conversation has. Zero when it is no longer stored. */
  messageCount: number;
};

export const CONTEXT_LIMITS = {
  before: 2,
  after: 2,
  ending: 4,
  humanChars: 1_200,
  assistantChars: 700,
  decisions: 8,
} as const;

export const CUT_MARKER = "[…]";

/** Shortens long text, keeping the start and the end and marking the cut. */
export function excerpt(text: string, limit: number): string {
  const clean = text.trim();
  if (clean.length <= limit) return clean;
  const head = Math.floor(limit * 0.65);
  return `${clean.slice(0, head).trimEnd()} ${CUT_MARKER} ${clean.slice(-(limit - head)).trimStart()}`;
}

function toContextMessage(message: StoredMessage, isEvidence: boolean): ContextMessage {
  return {
    id: message.id,
    sender: message.sender,
    createdAt: message.createdAt,
    text: excerpt(
      redact(message.text),
      message.sender === "human" ? CONTEXT_LIMITS.humanChars : CONTEXT_LIMITS.assistantChars,
    ),
    isEvidence,
  };
}

export function buildResumeContext(input: {
  task: TaskView;
  conversation: ResumeConversation | null;
  messages: StoredMessage[];
  decisions: DecisionView[];
}): ResumeContext {
  const { task, messages } = input;
  // Messages with no text (an attachment only, say) carry no context.
  const usable = messages.filter((message) => message.text.trim().length > 0);
  const evidence =
    task.evidence.find((entry) => entry.kind === "commitment" && entry.conversationId === input.conversation?.id) ??
    task.evidence.find((entry) => entry.kind === "commitment") ??
    null;

  const at = evidence?.messageId ? usable.findIndex((message) => message.id === evidence.messageId) : -1;
  const aroundStart = at === -1 ? 0 : Math.max(0, at - CONTEXT_LIMITS.before);
  const aroundEnd = at === -1 ? 0 : Math.min(usable.length, at + CONTEXT_LIMITS.after + 1);
  const around = usable
    .slice(aroundStart, aroundEnd)
    .map((message, index) => toContextMessage(message, aroundStart + index === at));

  const endingStart = Math.max(aroundEnd, usable.length - CONTEXT_LIMITS.ending);
  const ending = usable.slice(endingStart).map((message) => toContextMessage(message, false));

  return {
    task: {
      id: task.id,
      title: task.title,
      description: task.description,
      suggestedNextAction: task.suggestedNextAction,
      dueDate: task.dueDate,
      status: task.status,
    },
    conversation: input.conversation,
    commitment: evidence ? { quote: evidence.quote, saidAt: evidence.messageAt } : null,
    around,
    ending,
    decisions: input.decisions.filter((decision) => decision.quote.length > 0).slice(0, CONTEXT_LIMITS.decisions),
    messageCount: usable.length,
  };
}

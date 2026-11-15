import { CUT_MARKER, type ContextMessage, type ResumeContext } from "./context";
import type { InsightKind, ResumeInsights } from "./insights";

/**
 * Builds the continuation prompt from retrieved context. This is a template:
 * it only arranges what was retrieved. It makes no claim that is not backed
 * by a quotation shown in the prompt itself, and it tells the assistant that
 * it does not have the earlier conversation.
 */
const dateFormat = new Intl.DateTimeFormat("en-GB", { dateStyle: "long", timeZone: "UTC" });

function when(value: Date | string | null): string {
  if (!value) return "";
  const date = typeof value === "string" ? new Date(value) : value;
  return Number.isNaN(date.getTime()) ? "" : dateFormat.format(date);
}

function line(message: ContextMessage): string {
  const who = message.sender === "human" ? "Me" : "Assistant";
  const date = when(message.createdAt);
  return `${who}${date ? ` (${date})` : ""}:\n${message.text}`;
}

const INSIGHT_HEADINGS: Record<InsightKind, string> = {
  progress: "What had been done or worked out",
  decision: "Decisions already made",
  open_question: "What was still open",
};

export function buildResumePrompt(context: ResumeContext, insights: ResumeInsights | null = null): string {
  const sections: string[] = [];
  const { task } = context;

  sections.push(
    `I am picking up unfinished work from an earlier conversation. You do not have that conversation, so the relevant parts are below. Everything in quotation marks or under a speaker label is copied from it word for word; where a long message was shortened, the cut is marked ${CUT_MARKER}, and secrets, email addresses and long numbers were replaced with placeholders such as [secret].`,
  );

  const goal = [`## What I want to finish\n${task.title}`];
  if (task.description) goal.push(task.description);
  if (task.dueDate) goal.push(`I gave a deadline of ${when(task.dueDate) || task.dueDate}.`);
  sections.push(goal.join("\n\n"));

  if (context.commitment) {
    const said = when(context.commitment.saidAt);
    sections.push(`## What I said${said ? ` on ${said}` : ""}\n"${context.commitment.quote}"`);
  }

  if (context.around.length > 0) {
    sections.push(`## The conversation at that point\n${context.around.map(line).join("\n\n")}`);
  }
  if (context.ending.length > 0) {
    const heading = context.around.length > 0 ? "## How the conversation ended" : "## The end of the conversation";
    sections.push(`${heading}\n${context.ending.map(line).join("\n\n")}`);
  }

  if (context.decisions.length > 0) {
    sections.push(
      `## Decisions I made on this project\n${context.decisions
        .map((decision) => `- ${decision.text}\n  From: "${decision.quote}"`)
        .join("\n")}`,
    );
  }

  if (insights) {
    for (const kind of ["progress", "decision", "open_question"] as const) {
      const points = insights.points.filter((entry) => entry.kind === kind);
      if (points.length === 0) continue;
      sections.push(
        `## ${INSIGHT_HEADINGS[kind]}\n${points
          .map((entry) => `- ${entry.text}\n  From ${entry.sender === "human" ? "me" : "the assistant"}: "${entry.quote}"`)
          .join("\n")}`,
      );
    }
  }

  if (context.messageCount === 0) {
    sections.push(
      "## Note\nThe original conversation is no longer stored, so I can only give you what is above. Ask me for anything else you need.",
    );
  }

  const next = task.suggestedNextAction
    ? `Then help me with the next step: ${task.suggestedNextAction}`
    : "Then help me work out the next concrete step.";
  sections.push(
    `## What I need from you\nFirst, tell me in two or three sentences where you understand this to stand. Rely only on what is above. If something you need is missing, ask me instead of assuming. ${next}`,
  );

  return sections.join("\n\n");
}

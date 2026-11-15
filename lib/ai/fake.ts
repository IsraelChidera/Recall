import "server-only";

import { titleSimilarity } from "@/lib/domain/discovery";

import { EXTRACTION_SYSTEM, RECONCILIATION_SYSTEM, RESUME_SYSTEM, SCREENING_SYSTEM } from "./prompts";
import {
  AIResponseError,
  estimateTokens,
  type AIProvider,
  type StructuredRequest,
  type StructuredResponse,
} from "./provider";

/**
 * A deterministic stand-in for a language model, for tests and for running
 * the app locally without an API key (AI_PROVIDER=fake). It recognises a few
 * fixed phrasings ("I will ...", "I need to ...", "Done, ...") and nothing
 * else. It is refused in production.
 */
const INTENT = /\b(I will|I'll|I am going to|I'm going to|I need to|I want to|I plan to|I should)\b/i;

function titleFrom(action: string): string {
  const cleaned = action.replace(/\s+/g, " ").replace(/[.!?]+$/, "").trim().slice(0, 120);
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

type Parsed = { ref: string; sender: "USER" | "ASSISTANT"; text: string };

function parseTranscript(prompt: string): Parsed[] {
  const body = prompt.split("--- TRANSCRIPT ---")[1]?.split("--- END TRANSCRIPT ---")[0] ?? "";
  const messages: Parsed[] = [];
  const pattern = /\[(m\d+)\] (USER|ASSISTANT)[^\n]*\n([\s\S]*?)(?=\n\[m\d+\] (?:USER|ASSISTANT)|$)/g;
  for (const match of body.matchAll(pattern)) {
    messages.push({ ref: match[1]!, sender: match[2] as Parsed["sender"], text: match[3]!.trim() });
  }
  return messages;
}

function screen(prompt: string) {
  const results = [...prompt.matchAll(/### Conversation (\d+)\n([\s\S]*?)(?=\n\n### Conversation |$)/g)].map(
    (match) => {
      const keep = INTENT.test(match[2]!);
      return { n: Number(match[1]), keep, reason: keep ? "States an intention" : "No stated intention" };
    },
  );
  return { results };
}

function extract(prompt: string) {
  const messages = parseTranscript(prompt);
  const users = messages.filter((message) => message.sender === "USER");
  const items: Record<string, unknown>[] = [];

  for (const message of users) {
    const sentence = message.text.split(/(?<=[.!?])\s+/)[0] ?? message.text;
    const strong = /\b(?:I will|I'll|I am going to|I'm going to) ([^.!?]+)/i.exec(sentence);
    const weak = /\b(?:I need to|I want to|I plan to|I should) ([^.!?]+)/i.exec(sentence);
    const idle = /thinking out loud|maybe one day/i.test(sentence);
    const action = strong?.[1] ?? weak?.[1];
    if (!action && !idle) continue;
    items.push({
      title: idle ? "Explore the idea" : titleFrom(action!),
      description: "",
      category: strong ? "explicit_commitment" : weak ? "pending_action" : "future_intention",
      commitmentClass: idle ? "brainstorm" : strong ? "explicit_commitment" : "intention",
      priority: strong ? "high" : "medium",
      evidenceRef: message.ref,
      evidenceQuote: sentence.slice(0, 480),
      suggestedNextAction: idle ? "" : `Continue: ${titleFrom(action!)}`.slice(0, 280),
      dueDate: null,
      dueDateQuote: null,
      completed: false,
      completionRef: null,
      completionQuote: null,
    });
  }

  const done = users.find((message) => /^Done\b/i.test(message.text));
  const open = items.find((item) => item.commitmentClass !== "brainstorm");
  if (done && open) {
    open.completed = true;
    open.completionRef = done.ref;
    open.completionQuote = (done.text.split(/(?<=[.!?])\s+/)[0] ?? done.text).slice(0, 480);
  }

  const existingTasks = [...prompt.matchAll(/^(t\d+): /gm)].map((match) => ({
    ref: match[1]!,
    state: done ? "completed" : "still_open",
    evidenceRef: done ? done.ref : null,
    evidenceQuote: done ? (done.text.split(/(?<=[.!?])\s+/)[0] ?? done.text).slice(0, 480) : null,
  }));

  const hasWork = items.some((item) => item.commitmentClass !== "brainstorm");
  return {
    project: hasWork ? { name: "Synthetic work", description: "Work found by the stand-in provider." } : null,
    // Tasks already on record are reported under existingTasks, not repeated.
    items: existingTasks.length > 0 ? [] : items,
    decisions: [],
    existingTasks,
  };
}

function reconcile(prompt: string) {
  const pairs = [...prompt.matchAll(/### Pair (\d+)\nA: ([^\n]*)\nB: ([^\n]*)/g)].map((match) => ({
    n: Number(match[1]),
    same: titleSimilarity(match[2]!, match[3]!) >= 0.5,
  }));
  return { pairs };
}

/**
 * One supported point per kind, plus one whose quote is invented, so tests can
 * show that an unsupported point never reaches the user.
 */
function resume(prompt: string) {
  const messages = parseTranscript(prompt);
  const sentence = (text: string) => (text.split(/(?<=[.!?])\s+/)[0] ?? text).slice(0, 300);
  const user = messages.find((message) => message.sender === "USER" && INTENT.test(message.text));
  const assistant = messages.find((message) => message.sender === "ASSISTANT");
  const last = messages.at(-1);
  return {
    progress: [
      ...(assistant ? [{ text: "The assistant had replied to the request.", ref: assistant.ref, quote: sentence(assistant.text) }] : []),
      { text: "A final version had been delivered.", ref: last?.ref ?? "m1", quote: "This sentence appears nowhere in the conversation." },
    ],
    decisions: [],
    openQuestions: user ? [{ text: "The stated intention had not been carried out.", ref: user.ref, quote: sentence(user.text) }] : [],
  };
}

export class FakeProvider implements AIProvider {
  readonly name = "fake";
  readonly requests: StructuredRequest<unknown>[] = [];

  async generateStructured<T>(request: StructuredRequest<T>): Promise<StructuredResponse<T>> {
    this.requests.push(request);
    const raw =
      request.system === SCREENING_SYSTEM
        ? screen(request.prompt)
        : request.system === EXTRACTION_SYSTEM
          ? extract(request.prompt)
          : request.system === RECONCILIATION_SYSTEM
            ? reconcile(request.prompt)
            : request.system === RESUME_SYSTEM
              ? resume(request.prompt)
              : null;
    const parsed = request.schema.safeParse(raw);
    if (!parsed.success) throw new AIResponseError("the stand-in provider has no answer for this request");
    return {
      data: parsed.data,
      model: "fake",
      usage: {
        inputTokens: estimateTokens(request.system + request.prompt),
        outputTokens: estimateTokens(JSON.stringify(raw)),
      },
    };
  }
}

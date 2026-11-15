import type { StoredMessage } from "@/lib/import/plan";

import { redact } from "./redact";

/**
 * Turns stored messages into the labelled, redacted text shown to the model.
 * Messages are labelled [m1], [m2], ... The model answers with those labels;
 * the server maps them back to real message ids. The model never sees an id.
 */
export type PromptMessage = {
  /** 1-based position in the conversation; the label is `m${ordinal}`. */
  ordinal: number;
  id: string;
  sender: "human" | "assistant";
  createdAt: string | null;
  /** Redacted, and for assistant messages shortened. Evidence is verified against this. */
  text: string;
};

export const TRANSCRIPT_LIMITS = {
  humanChars: 8_000,
  assistantChars: 1_500,
  windowChars: 100_000,
  overlapMessages: 4,
  maxWindows: 4,
} as const;

function shorten(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const head = Math.floor(limit * 0.65);
  const tail = limit - head;
  return `${text.slice(0, head)}\n[…]\n${text.slice(-tail)}`;
}

/**
 * Stored messages are written by the browser, so their shape is checked here
 * instead of trusted: anything that is not text becomes empty text.
 */
export function toPromptMessages(messages: StoredMessage[]): PromptMessage[] {
  return messages.map((message, index) => {
    const sender = message?.sender === "assistant" ? "assistant" : "human";
    return {
      ordinal: index + 1,
      id: typeof message?.id === "string" ? message.id : "",
      sender,
      createdAt: typeof message?.createdAt === "string" ? message.createdAt : null,
      text: shorten(
        redact(typeof message?.text === "string" ? message.text : ""),
        sender === "human" ? TRANSCRIPT_LIMITS.humanChars : TRANSCRIPT_LIMITS.assistantChars,
      ),
    };
  });
}

export function renderMessage(message: PromptMessage): string {
  const who = message.sender === "human" ? "USER" : "ASSISTANT";
  const when = message.createdAt ? ` ${message.createdAt.slice(0, 10)}` : "";
  return `[m${message.ordinal}] ${who}${when}\n${message.text}`;
}

/**
 * Splits a long conversation into overlapping windows that each fit one
 * request. Very long conversations keep the first window and the last three,
 * because commitments cluster at the start and resolutions at the end.
 */
export function windowMessages(messages: PromptMessage[]): PromptMessage[][] {
  const windows: PromptMessage[][] = [];
  let current: PromptMessage[] = [];
  let size = 0;

  for (const message of messages) {
    const length = message.text.length + 40;
    if (current.length > 0 && size + length > TRANSCRIPT_LIMITS.windowChars) {
      windows.push(current);
      current = current.slice(-TRANSCRIPT_LIMITS.overlapMessages);
      size = current.reduce((sum, item) => sum + item.text.length + 40, 0);
    }
    current.push(message);
    size += length;
  }
  if (current.length > 0) windows.push(current);

  if (windows.length <= TRANSCRIPT_LIMITS.maxWindows) return windows;
  return [windows[0]!, ...windows.slice(-(TRANSCRIPT_LIMITS.maxWindows - 1))];
}

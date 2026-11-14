import type { PromptMessage } from "./transcript";

/**
 * Evidence verification. A discovery is kept only if its quote really appears
 * in the conversation. This is what stops a model from inventing commitments.
 */
export function normaliseForMatch(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

const MIN_QUOTE_LENGTH = 8;
const ELLIPSIS = /\s*(?:\.{3,}|…|\[…\])\s*/;

/** True when every part of the quote appears in the text, in order. */
function containsInOrder(haystack: string, parts: string[]): boolean {
  let from = 0;
  for (const part of parts) {
    const at = haystack.indexOf(part, from);
    if (at === -1) return false;
    from = at + part.length;
  }
  return true;
}

export type VerifiedQuote = {
  message: PromptMessage;
  /** False when the quote was found in a different message than the model named. */
  refExact: boolean;
};

/**
 * Finds the quote in the message the model pointed at. If it is not there but
 * appears in exactly one other message, that message is used. Otherwise the
 * quote is rejected.
 */
export function verifyQuote(
  quote: string | null | undefined,
  ref: string | null | undefined,
  messages: PromptMessage[],
): VerifiedQuote | null {
  if (!quote) return null;
  const parts = normaliseForMatch(quote)
    .split(ELLIPSIS)
    .map((part) => part.replace(/^["']+|["']+$/g, "").trim())
    .filter((part) => part.length > 0);
  if (parts.join(" ").length < MIN_QUOTE_LENGTH) return null;

  const matches = (message: PromptMessage) =>
    containsInOrder(normaliseForMatch(message.text), parts);

  const ordinal = ref ? Number.parseInt(ref.slice(1), 10) : Number.NaN;
  const named = messages.find((message) => message.ordinal === ordinal);
  if (named && matches(named)) return { message: named, refExact: true };

  const elsewhere = messages.filter(matches);
  if (elsewhere.length === 1) return { message: elsewhere[0]!, refExact: false };
  return null;
}

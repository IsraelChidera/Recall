import type { PromptMessage } from "@/lib/ai/transcript";

/**
 * Chooses which messages of a conversation go into the single AI request
 * that prepares a continuation prompt. A conversation that fits is sent
 * whole. A longer one is cut to the messages around the commitment and the
 * end of the conversation, since that is where the state of the work shows.
 */
export const SELECT_LIMITS = { totalChars: 60_000, aroundShare: 0.5 } as const;

const size = (message: PromptMessage) => message.text.length + 40;

export function selectForResume(
  messages: PromptMessage[],
  evidenceId: string | null,
  totalChars: number = SELECT_LIMITS.totalChars,
): PromptMessage[] {
  const total = messages.reduce((sum, message) => sum + size(message), 0);
  if (total <= totalChars) return messages;

  const chosen = new Set<number>();
  let used = 0;
  const take = (index: number, budget: number) => {
    if (index < 0 || index >= messages.length || chosen.has(index)) return true;
    const cost = size(messages[index]!);
    // Always keep at least one message, even an oversized one.
    if (used + cost > budget && chosen.size > 0) return false;
    chosen.add(index);
    used += cost;
    return true;
  };

  const at = evidenceId ? messages.findIndex((message) => message.id === evidenceId) : -1;
  if (at !== -1) {
    const budget = totalChars * SELECT_LIMITS.aroundShare;
    take(at, budget);
    for (let step = 1; step < messages.length; step++) {
      const after = take(at + step, budget);
      const before = take(at - step, budget);
      if (!after || !before) break;
    }
  }
  for (let index = messages.length - 1; index >= 0; index--) {
    if (!take(index, totalChars)) break;
  }
  return [...chosen].sort((a, b) => a - b).map((index) => messages[index]!);
}

import {
  ASSISTANT_TEXT_LIMIT,
  DIGEST_LIMIT,
  HUMAN_TEXT_LIMIT,
  TITLE_LIMIT,
  type NormalisedMessage,
} from "@/lib/domain/conversation";
import { conversationContentHash } from "@/lib/domain/hash";
import type { NormaliseResult, SourceAdapter } from "@/lib/sources/types";

import { rawConversationSchema, rawMessageSchema, type RawMessage } from "./schema";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONVERSATIONS_ENTRY = /(^|\/)conversations(-\d+)?\.json$/i;

function isoOrNull(value: string | null | undefined): string | null {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

function clip(text: string, limit: number): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false };
  return { text: text.slice(0, limit), truncated: true };
}

/**
 * Visible text of a message: its `text` content blocks joined. Thinking, tool
 * calls and tool results are left out because they inflate size and rarely
 * state a commitment. Falls back to the flat `text` field when a message has
 * no content blocks at all (older exports).
 */
function visibleText(message: RawMessage): string {
  const blocks = message.content ?? [];
  if (blocks.length === 0) return (message.text ?? "").trim();
  return blocks
    .filter((block) => block.type === "text" && block.text)
    .map((block) => block.text as string)
    .join("\n\n")
    .trim();
}

/**
 * The export contains every branch of a conversation. The active thread is
 * taken to be the path from the most recent leaf back to the root; messages
 * on other branches are edits or regenerations that were superseded.
 *
 * Falls back to export order when the parent links are unusable.
 */
export function activeBranch(messages: RawMessage[]): RawMessage[] {
  if (messages.length === 0) return [];
  const byId = new Map(messages.map((message) => [message.uuid, message]));
  const hasChild = new Set<string>();
  for (const message of messages) {
    const parent = message.parent_message_uuid;
    if (parent && byId.has(parent)) hasChild.add(parent);
  }

  // No usable links at all (older or damaged exports): there is no tree to
  // walk, so the export order is the thread.
  if (hasChild.size === 0 && messages.length > 1) return messages;

  const leaves = messages.filter((message) => !hasChild.has(message.uuid));
  if (leaves.length === 0) return messages;

  const time = (message: RawMessage) => Date.parse(message.created_at ?? "") || 0;
  let leaf = leaves[0] as RawMessage;
  for (const candidate of leaves) {
    // Later timestamp wins; export order breaks ties.
    if (time(candidate) >= time(leaf)) leaf = candidate;
  }

  const path: RawMessage[] = [];
  const seen = new Set<string>();
  let current: RawMessage | undefined = leaf;
  while (current && !seen.has(current.uuid)) {
    seen.add(current.uuid);
    path.push(current);
    current = current.parent_message_uuid ? byId.get(current.parent_message_uuid) : undefined;
  }
  return path.reverse();
}

function buildDigest(title: string, summary: string, humanTexts: string[]): string {
  const first = humanTexts[0] ?? "";
  const last = humanTexts.length > 1 ? (humanTexts.at(-1) ?? "") : "";
  const parts = [
    title && `Title: ${title}`,
    summary && `Summary: ${summary.slice(0, 1_800)}`,
    first && `First request: ${first.slice(0, 900)}`,
    last && `Latest request: ${last.slice(0, 900)}`,
  ].filter(Boolean);
  return parts.join("\n\n").slice(0, DIGEST_LIMIT);
}

export const claudeAdapter: SourceAdapter = {
  id: "claude",
  label: "Claude",
  version: 1,

  conversationEntries(entryNames) {
    return entryNames.filter((name) => CONVERSATIONS_ENTRY.test(name));
  },

  async normalise(raw): Promise<NormaliseResult> {
    const parsed = rawConversationSchema.safeParse(raw);
    if (!parsed.success) {
      const id =
        typeof raw === "object" && raw !== null && "uuid" in raw && typeof raw.uuid === "string"
          ? raw.uuid
          : null;
      return { ok: false, reason: "Conversation is missing required fields.", sourceConversationId: id };
    }
    const conversation = parsed.data;
    if (!UUID.test(conversation.uuid)) {
      return { ok: false, reason: "Conversation identifier is not a UUID.", sourceConversationId: null };
    }

    const rawMessages: RawMessage[] = [];
    for (const candidate of conversation.chat_messages ?? []) {
      const message = rawMessageSchema.safeParse(candidate);
      // A malformed message, or one from an unknown sender, is dropped before
      // the thread is traced; the rest of the conversation is kept.
      if (!message.success) continue;
      if (message.data.sender !== "human" && message.data.sender !== "assistant") continue;
      rawMessages.push(message.data);
    }

    const thread = activeBranch(rawMessages);
    const messages: NormalisedMessage[] = [];
    let totalTextLength = 0;

    for (const message of thread) {
      if (message.sender !== "human" && message.sender !== "assistant") continue;
      const full = visibleText(message);
      totalTextLength += full.length;
      const limit = message.sender === "human" ? HUMAN_TEXT_LIMIT : ASSISTANT_TEXT_LIMIT;
      const { text, truncated } = clip(full, limit);
      messages.push({
        id: message.uuid,
        sender: message.sender,
        createdAt: isoOrNull(message.created_at),
        text,
        truncated,
        attachmentCount: (message.attachments?.length ?? 0) + (message.files?.length ?? 0),
        toolUseCount: (message.content ?? []).filter((block) => block.type === "tool_use").length,
      });
    }

    const title = (conversation.name ?? "").trim().slice(0, TITLE_LIMIT);
    const humanTexts = messages
      .filter((message) => message.sender === "human" && message.text)
      .map((message) => message.text);
    const updatedAtSource = isoOrNull(conversation.updated_at);

    return {
      ok: true,
      conversation: {
        id: `claude_${conversation.uuid.toLowerCase()}`,
        sourceId: "claude",
        sourceConversationId: conversation.uuid.toLowerCase(),
        title,
        createdAtSource: isoOrNull(conversation.created_at),
        updatedAtSource,
        sourceUrl: `https://claude.ai/chat/${conversation.uuid.toLowerCase()}`,
        digest: buildDigest(title, (conversation.summary ?? "").trim(), humanTexts),
        contentHash: await conversationContentHash({
          updatedAt: updatedAtSource,
          messageIds: messages.map((message) => message.id),
          totalTextLength,
        }),
        messageCount: messages.length,
        humanMessageCount: humanTexts.length,
        offBranchMessageCount: rawMessages.length - thread.length,
        messages,
      },
    };
  },
};

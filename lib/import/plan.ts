import type { NormalisedConversation, NormalisedMessage } from "@/lib/domain/conversation";

/**
 * Pure planning logic for saving an import. Nothing here touches Firestore,
 * so it runs in tests and in the browser unchanged.
 */

/** conversation document id -> content hash of what is already saved. */
export type SourceIndex = Map<string, string>;

export type Classification = "new" | "updated" | "unchanged";

export function classify(
  conversation: Pick<NormalisedConversation, "id" | "contentHash">,
  index: SourceIndex,
): Classification {
  const saved = index.get(conversation.id);
  if (saved === undefined) return "new";
  return saved === conversation.contentHash ? "unchanged" : "updated";
}

export type ImportPlan = {
  total: number;
  new: number;
  updated: number;
  unchanged: number;
  /** Saved earlier but absent from this export. They are kept. */
  notInThisExport: number;
};

export function planImport(
  conversations: Iterable<Pick<NormalisedConversation, "id" | "contentHash">>,
  index: SourceIndex,
): ImportPlan {
  const plan: ImportPlan = { total: 0, new: 0, updated: 0, unchanged: 0, notInThisExport: 0 };
  // The same conversation can appear twice in one upload; the last copy wins.
  const latest = new Map<string, string>();
  for (const conversation of conversations) latest.set(conversation.id, conversation.contentHash);

  for (const [id, contentHash] of latest) {
    plan.total++;
    plan[classify({ id, contentHash }, index)]++;
  }
  for (const id of index.keys()) {
    if (!latest.has(id)) plan.notInThisExport++;
  }
  return plan;
}

/**
 * The index is split across a fixed number of documents so one document never
 * exceeds the 2,000-entry cap in the security rules. Capacity is 16,000
 * conversations per source.
 */
export const INDEX_SHARDS = 8;
export const INDEX_SHARD_CAPACITY = 2_000;

export function indexShardId(sourceId: string, sourceConversationId: string): string {
  const first = Number.parseInt(sourceConversationId.charAt(0), 16);
  const bucket = Number.isNaN(first) ? 0 : first % INDEX_SHARDS;
  return `${sourceId}_${bucket}`;
}

export function allIndexShardIds(sourceId: string): string[] {
  return Array.from({ length: INDEX_SHARDS }, (_, bucket) => `${sourceId}_${bucket}`);
}

export type StoredMessage = Pick<
  NormalisedMessage,
  "id" | "sender" | "createdAt" | "text" | "truncated"
>;

export type Chunk = { index: number; messages: StoredMessage[]; charCount: number };

/** Kept well under Firestore's 1 MiB document limit even for 3-byte characters. */
export const CHUNK_LIMITS = { characters: 180_000, messages: 400 } as const;

/**
 * Packs a conversation's messages into ordered chunk documents. A conversation
 * with no messages produces no chunks.
 */
export function chunkMessages(messages: NormalisedMessage[]): Chunk[] {
  const chunks: Chunk[] = [];
  let current: Chunk | null = null;

  for (const message of messages) {
    const size = message.text.length;
    if (
      current === null ||
      current.messages.length >= CHUNK_LIMITS.messages ||
      (current.messages.length > 0 && current.charCount + size > CHUNK_LIMITS.characters)
    ) {
      current = { index: chunks.length, messages: [], charCount: 0 };
      chunks.push(current);
    }
    current.messages.push({
      id: message.id,
      sender: message.sender,
      createdAt: message.createdAt,
      text: message.text,
      truncated: message.truncated,
    });
    current.charCount += size;
  }
  return chunks;
}

import type { NormalisedConversation } from "@/lib/domain/conversation";

export type NormaliseResult =
  | { ok: true; conversation: NormalisedConversation }
  | { ok: false; reason: string; sourceConversationId: string | null };

/**
 * One implementation per AI platform. Adding a platform means adding an
 * adapter and one line in the registry; nothing else in the importer changes.
 */
export interface SourceAdapter {
  /** Stable identifier, also the prefix of conversation document ids. */
  readonly id: string;
  readonly label: string;
  /** Bumped when normalisation changes in a way that requires re-import. */
  readonly version: number;
  /**
   * Given the entry names of an archive, returns the entries that hold
   * conversations, or an empty list when the archive is not from this source.
   * Each returned entry must be a JSON file whose root is an array of
   * conversations.
   */
  conversationEntries(entryNames: string[]): string[];
  /** Maps one raw conversation to Recall's shape. Never throws. */
  normalise(raw: unknown): Promise<NormaliseResult>;
}

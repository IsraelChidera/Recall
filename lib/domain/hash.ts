/**
 * SHA-256 as lowercase hex, using Web Crypto. Available in browsers, workers
 * and Node 22, so the same code runs in the import worker and in tests.
 */
export async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Fingerprint of a conversation's content. Two exports of an unchanged
 * conversation produce the same hash; any new, edited or removed message
 * changes it. Used to skip unchanged conversations on re-import.
 */
export async function conversationContentHash(parts: {
  updatedAt: string | null;
  messageIds: string[];
  totalTextLength: number;
}): Promise<string> {
  const basis = [
    parts.updatedAt ?? "",
    parts.messageIds.length,
    parts.messageIds.at(-1) ?? "",
    parts.totalTextLength,
  ].join("|");
  return (await sha256Hex(basis)).slice(0, 40);
}

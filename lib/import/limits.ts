/** Guard rails for archives read in the browser. */
export const IMPORT_LIMITS = {
  /** Above this compressed size the user is warned that memory may run short. */
  warnZipBytes: 150 * 1024 * 1024,
  /** JSZip holds the compressed archive in memory, so this is a hard stop. */
  maxZipBytes: 400 * 1024 * 1024,
  maxFiles: 20,
  maxEntriesPerZip: 5_000,
  /** Ceiling on decompressed bytes streamed from one entry (zip-bomb guard). */
  maxEntryBytes: 2 * 1024 * 1024 * 1024,
  maxConversationBytes: 64 * 1024 * 1024,
  maxIssuesKept: 50,
} as const;

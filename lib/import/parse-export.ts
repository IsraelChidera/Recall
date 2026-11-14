import JSZip from "jszip";

import type { NormalisedConversation } from "@/lib/domain/conversation";
import { sha256Hex } from "@/lib/domain/hash";
import { sourceAdapters } from "@/lib/sources/registry";
import type { SourceAdapter } from "@/lib/sources/types";

import { JsonArrayElementSplitter, JsonArrayStreamError } from "./json-array-stream";
import { IMPORT_LIMITS } from "./limits";

export type ImportFileInput = {
  name: string;
  size: number;
  /** A File in the browser; bytes in tests. */
  data: Blob | Uint8Array | ArrayBuffer;
};

export type ImportFileOutcome = {
  name: string;
  status: "parsed" | "ignored" | "rejected";
  reason?: string;
  conversations?: number;
};

export type ImportIssue = {
  file: string;
  /** Present when the conversation could be identified. Never contains message text. */
  sourceConversationId: string | null;
  reason: string;
};

export type ImportStats = {
  conversations: number;
  messages: number;
  humanMessages: number;
  duplicates: number;
  skipped: number;
  offBranchMessages: number;
  truncatedMessages: number;
  earliest: string | null;
  latest: string | null;
};

export type ImportResult = {
  sourceId: string | null;
  adapterVersion: number | null;
  /** Identical for two uploads of the same export content. */
  fingerprint: string;
  files: ImportFileOutcome[];
  stats: ImportStats;
  issues: ImportIssue[];
  issueCount: number;
  warnings: string[];
};

export type ImportProgress = {
  fileName: string;
  fileIndex: number;
  fileCount: number;
  conversations: number;
};

export type ParseHandlers = {
  /** Called once per conversation, in order. Awaited, so it applies backpressure. */
  onConversation: (conversation: NormalisedConversation) => void | Promise<void>;
  onProgress?: (progress: ImportProgress) => void;
};

export class ImportAbortedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportAbortedError";
  }
}

const ZIP_SIGNATURES = [
  [0x50, 0x4b, 0x03, 0x04],
  [0x50, 0x4b, 0x05, 0x06],
];

async function headBytes(data: ImportFileInput["data"]): Promise<Uint8Array> {
  // Duck-typed, not `instanceof`: bytes created in another realm (a worker
  // message, a test environment) fail instanceof checks against local globals.
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, Math.min(4, data.byteLength));
  }
  if ("arrayBuffer" in data && typeof data.arrayBuffer === "function") {
    return new Uint8Array(await data.slice(0, 4).arrayBuffer());
  }
  return new Uint8Array(data as ArrayBuffer, 0, Math.min(4, (data as ArrayBuffer).byteLength));
}

function looksLikeZip(head: Uint8Array): boolean {
  return ZIP_SIGNATURES.some((signature) => signature.every((byte, i) => head[i] === byte));
}

function unsafeEntryName(name: string): boolean {
  if (name.startsWith("/") || name.startsWith("\\") || /^[A-Za-z]:/.test(name)) return true;
  return name.split(/[\\/]/).includes("..");
}

/**
 * `internalStream` is part of JSZip's documented API but is missing from its
 * type definitions.
 */
type StreamableEntry = JSZip.JSZipObject & {
  internalStream(type: "uint8array"): JSZip.JSZipStreamHelper<Uint8Array>;
};

/** Streams one zip entry, awaiting `onChunk` before more data is read. */
function streamEntry(
  entry: JSZip.JSZipObject,
  onChunk: (chunk: Uint8Array) => Promise<void>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const stream = (entry as StreamableEntry).internalStream("uint8array");
    let chain: Promise<void> = Promise.resolve();
    let failed = false;

    stream.on("data", (chunk) => {
      stream.pause();
      chain = chain
        .then(() => onChunk(chunk))
        .then(() => {
          if (!failed) stream.resume();
        })
        .catch((error: unknown) => {
          failed = true;
          reject(error);
        });
    });
    stream.on("error", (error) => {
      failed = true;
      reject(error);
    });
    stream.on("end", () => {
      void chain.then(() => {
        if (!failed) resolve();
      });
    });
    stream.resume();
  });
}

function pickAdapter(entryNames: string[]): { adapter: SourceAdapter; entries: string[] } | null {
  for (const adapter of sourceAdapters) {
    const entries = adapter.conversationEntries(entryNames);
    if (entries.length > 0) return { adapter, entries };
  }
  return null;
}

/**
 * Parses one or more export ZIPs and reports each conversation through
 * `onConversation`. Conversation text is never accumulated here, so memory is
 * bounded by the compressed archives plus one conversation at a time.
 *
 * A malformed conversation is recorded as an issue and skipped. A file that
 * is not a conversations archive is ignored. Only a problem that makes the
 * whole upload unusable throws.
 */
export async function parseExport(
  files: ImportFileInput[],
  handlers: ParseHandlers,
): Promise<ImportResult> {
  if (files.length === 0) throw new ImportAbortedError("Choose at least one ZIP file.");
  if (files.length > IMPORT_LIMITS.maxFiles) {
    throw new ImportAbortedError(`Upload at most ${IMPORT_LIMITS.maxFiles} files at a time.`);
  }

  const result: ImportResult = {
    sourceId: null,
    adapterVersion: null,
    fingerprint: "",
    files: [],
    stats: {
      conversations: 0,
      messages: 0,
      humanMessages: 0,
      duplicates: 0,
      skipped: 0,
      offBranchMessages: 0,
      truncatedMessages: 0,
      earliest: null,
      latest: null,
    },
    issues: [],
    issueCount: 0,
    warnings: [],
  };

  /** conversation id -> content hash, for de-duplication across files and parts. */
  const seen = new Map<string, string>();
  const decoder = new TextDecoder("utf-8");

  const addIssue = (issue: ImportIssue) => {
    result.issueCount++;
    if (result.issues.length < IMPORT_LIMITS.maxIssuesKept) result.issues.push(issue);
  };

  for (const [fileIndex, file] of files.entries()) {
    const reject = (reason: string) => result.files.push({ name: file.name, status: "rejected", reason });

    if (file.size > IMPORT_LIMITS.maxZipBytes) {
      reject("This file is too large to open in the browser.");
      continue;
    }
    if (!looksLikeZip(await headBytes(file.data))) {
      reject("This is not a ZIP file.");
      continue;
    }
    if (file.size > IMPORT_LIMITS.warnZipBytes) {
      result.warnings.push(`${file.name} is large. Close other tabs if the import fails.`);
    }

    let zip: JSZip;
    try {
      zip = await JSZip.loadAsync(file.data);
    } catch {
      reject("The ZIP file is corrupt or incomplete.");
      continue;
    }

    const entryNames = Object.values(zip.files)
      .filter((entry) => !entry.dir)
      .map((entry) => entry.name);
    if (entryNames.length > IMPORT_LIMITS.maxEntriesPerZip) {
      reject("The ZIP file contains too many entries.");
      continue;
    }
    if (entryNames.some(unsafeEntryName)) {
      reject("The ZIP file contains unsafe paths.");
      continue;
    }

    const match = pickAdapter(entryNames);
    if (!match) {
      result.files.push({
        name: file.name,
        status: "ignored",
        reason: "No conversations found in this file. Recall only reads the conversations part of an export.",
      });
      continue;
    }
    if (result.sourceId && result.sourceId !== match.adapter.id) {
      reject("This file is from a different platform than the others. Import one platform at a time.");
      continue;
    }
    result.sourceId = match.adapter.id;
    result.adapterVersion = match.adapter.version;

    let fileConversations = 0;
    let fileFailed: string | null = null;

    for (const entryName of match.entries) {
      const entry = zip.file(entryName);
      if (!entry) continue;
      const splitter = new JsonArrayElementSplitter(IMPORT_LIMITS.maxConversationBytes);
      let entryBytes = 0;

      try {
        await streamEntry(entry, async (chunk) => {
          entryBytes += chunk.length;
          if (entryBytes > IMPORT_LIMITS.maxEntryBytes) {
            throw new JsonArrayStreamError("The conversations file is larger than the supported limit.");
          }
          for (const bytes of splitter.push(chunk)) {
            let raw: unknown;
            try {
              raw = JSON.parse(decoder.decode(bytes));
            } catch {
              result.stats.skipped++;
              addIssue({ file: file.name, sourceConversationId: null, reason: "Conversation is not valid JSON." });
              continue;
            }

            const normalised = await match.adapter.normalise(raw);
            if (!normalised.ok) {
              result.stats.skipped++;
              addIssue({
                file: file.name,
                sourceConversationId: normalised.sourceConversationId,
                reason: normalised.reason,
              });
              continue;
            }

            const conversation = normalised.conversation;
            const previousHash = seen.get(conversation.id);
            if (previousHash !== undefined) {
              result.stats.duplicates++;
              // The same conversation in two files: identical copies are
              // dropped. A differing copy is passed on so the latest wins.
              if (previousHash === conversation.contentHash) continue;
            } else {
              result.stats.conversations++;
              result.stats.messages += conversation.messageCount;
              result.stats.humanMessages += conversation.humanMessageCount;
              result.stats.offBranchMessages += conversation.offBranchMessageCount;
              result.stats.truncatedMessages += conversation.messages.filter((m) => m.truncated).length;
              const stamp = conversation.updatedAtSource ?? conversation.createdAtSource;
              if (stamp) {
                if (!result.stats.earliest || stamp < result.stats.earliest) result.stats.earliest = stamp;
                if (!result.stats.latest || stamp > result.stats.latest) result.stats.latest = stamp;
              }
            }
            seen.set(conversation.id, conversation.contentHash);
            fileConversations++;

            await handlers.onConversation(conversation);
            handlers.onProgress?.({
              fileName: file.name,
              fileIndex,
              fileCount: files.length,
              conversations: result.stats.conversations,
            });
          }
        });
        splitter.end();
      } catch (error) {
        fileFailed =
          error instanceof JsonArrayStreamError
            ? error.message
            : "The conversations file could not be read to the end.";
        break;
      }
    }

    if (fileFailed) {
      // Conversations read before the failure are kept; the user is told the
      // file was incomplete so they can download it again.
      result.files.push({
        name: file.name,
        status: "rejected",
        reason: fileFailed,
        conversations: fileConversations,
      });
    } else {
      result.files.push({ name: file.name, status: "parsed", conversations: fileConversations });
    }
  }

  const basis = [...seen.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([id, hash]) => `${id}:${hash}`)
    .join("\n");
  result.fingerprint = (await sha256Hex(`${result.sourceId ?? "none"}\n${basis}`)).slice(0, 40);

  return result;
}

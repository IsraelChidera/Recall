import {
  collection,
  deleteField,
  doc,
  FieldPath,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  serverTimestamp,
  Timestamp,
  where,
  writeBatch,
  type Firestore,
} from "firebase/firestore";

import type { NormalisedConversation } from "@/lib/domain/conversation";

import type { ImportIssue } from "./parse-export";
import {
  allIndexShardIds,
  chunkMessages,
  classify,
  INDEX_SHARD_CAPACITY,
  indexShardId,
  type ImportPlan,
  type SourceIndex,
} from "./plan";

/**
 * Saves imported conversations to Firestore from the browser, under the
 * signed-in user's security rules.
 *
 * Idempotency rests on two things. Document ids are derived from the source
 * (`claude_<uuid>`), so writing a conversation twice overwrites one document.
 * And each batch commits the conversations together with their index entries
 * and the import's progress, atomically. The index therefore always matches
 * what is saved: after any interruption, running the same import again writes
 * only what is still missing.
 */

export class ImportCapacityError extends Error {
  constructor() {
    super("This workspace has reached the number of conversations it can index.");
    this.name = "ImportCapacityError";
  }
}

function timestampOrNull(iso: string | null): Timestamp | null {
  if (!iso) return null;
  const time = Date.parse(iso);
  return Number.isNaN(time) ? null : Timestamp.fromMillis(time);
}

const count = (value: unknown) => (typeof value === "number" ? value : 0);

function toDate(value: unknown): Date | null {
  return typeof value === "object" && value !== null && "toDate" in value &&
    typeof value.toDate === "function"
    ? (value.toDate() as Date)
    : null;
}

const userPath = (uid: string, ...segments: string[]) => ["users", uid, ...segments].join("/");

/** Reads what is already saved for a source: at most eight small documents. */
export async function loadSourceIndex(
  db: Firestore,
  uid: string,
  sourceId: string,
): Promise<SourceIndex> {
  const index: SourceIndex = new Map();
  const snapshots = await Promise.all(
    allIndexShardIds(sourceId).map((shardId) => getDoc(doc(db, userPath(uid, "sourceIndex", shardId)))),
  );
  for (const snapshot of snapshots) {
    const entries = snapshot.data()?.entries as Record<string, unknown> | undefined;
    if (!entries) continue;
    for (const [id, hash] of Object.entries(entries)) {
      if (typeof hash === "string") index.set(id, hash);
    }
  }
  return index;
}

export type ImportWriterOptions = {
  sourceId: string;
  adapterVersion: number;
  /** The import fingerprint. The same export content always gives the same id. */
  importId: string;
  fileNames: string[];
  plan: ImportPlan;
  issues: ImportIssue[];
  /** The index as loaded when the plan was made. The writer keeps it current. */
  index: SourceIndex;
};

export type WriteProgress = { written: number; toWrite: number };

export class FirestoreImportWriter {
  private written = 0;
  private alreadyWritten = 0;
  private readonly shardSizes = new Map<string, number>();

  constructor(
    private readonly db: Firestore,
    private readonly uid: string,
    private readonly options: ImportWriterOptions,
  ) {
    for (const id of options.index.keys()) {
      const shard = this.shardFor(id);
      this.shardSizes.set(shard, (this.shardSizes.get(shard) ?? 0) + 1);
    }
  }

  get progress(): WriteProgress {
    return { written: this.written, toWrite: this.options.plan.new + this.options.plan.updated };
  }

  private shardFor(conversationId: string): string {
    const prefix = `${this.options.sourceId}_`;
    const sourceConversationId = conversationId.startsWith(prefix)
      ? conversationId.slice(prefix.length)
      : conversationId;
    return indexShardId(this.options.sourceId, sourceConversationId);
  }

  private importRef() {
    return doc(this.db, userPath(this.uid, "imports", this.options.importId));
  }

  private counts() {
    const { plan } = this.options;
    return {
      total: plan.total,
      new: plan.new,
      updated: plan.updated,
      unchanged: plan.unchanged,
      unreadable: this.options.issues.length,
    };
  }

  /** Creates the import record, or reopens it when the same export is resumed. */
  async begin(): Promise<void> {
    const ref = this.importRef();
    const existing = await getDoc(ref);
    const batch = writeBatch(this.db);
    const fields = {
      status: "writing",
      fileNames: this.options.fileNames.slice(0, 20).map((name) => name.slice(0, 200)),
      counts: this.counts(),
      errors: this.options.issues.slice(0, 50).map((issue) => ({
        reason: issue.reason.slice(0, 200),
        sourceConversationId: issue.sourceConversationId,
      })),
      completedAt: null,
      updatedAt: serverTimestamp(),
    };
    if (existing.exists()) {
      const cursor = existing.data().cursor;
      this.alreadyWritten = typeof cursor === "number" ? cursor : 0;
      batch.update(ref, fields);
    } else {
      batch.set(ref, {
        ...fields,
        sourceId: this.options.sourceId,
        fingerprint: this.options.importId,
        cursor: 0,
        createdAt: serverTimestamp(),
      });
    }
    await batch.commit();
  }

  /**
   * Writes the new and changed conversations of one batch. Unchanged ones are
   * skipped without a write. Resolves when the server has committed.
   */
  async writeBatch(conversations: NormalisedConversation[]): Promise<WriteProgress> {
    const { index, sourceId, importId } = this.options;

    // A changed conversation may now need fewer chunks. Its previous chunk
    // count is read first so the surplus can be deleted in the same batch.
    const previousChunkCounts = new Map<string, number>();
    await Promise.all(
      conversations
        .filter((conversation) => classify(conversation, index) === "updated")
        .map(async (conversation) => {
          const saved = await getDoc(doc(this.db, userPath(this.uid, "conversations", conversation.id)));
          previousChunkCounts.set(conversation.id, count(saved.data()?.chunkCount));
        }),
    );

    const batch = writeBatch(this.db);
    const shardEntries = new Map<string, Record<string, string>>();
    let writes = 0;

    for (const conversation of conversations) {
      const kind = classify(conversation, index);
      if (kind === "unchanged") continue;

      const shard = this.shardFor(conversation.id);
      if (kind === "new") {
        const size = (this.shardSizes.get(shard) ?? 0) + 1;
        if (size > INDEX_SHARD_CAPACITY) throw new ImportCapacityError();
        this.shardSizes.set(shard, size);
      }

      const chunks = chunkMessages(conversation.messages);
      const conversationRef = doc(this.db, userPath(this.uid, "conversations", conversation.id));
      const content = {
        sourceId,
        sourceConversationId: conversation.sourceConversationId,
        title: conversation.title,
        createdAtSource: timestampOrNull(conversation.createdAtSource),
        updatedAtSource: timestampOrNull(conversation.updatedAtSource),
        messageCount: conversation.messageCount,
        humanMessageCount: conversation.humanMessageCount,
        chunkCount: chunks.length,
        contentHash: conversation.contentHash,
        sourceUrl: conversation.sourceUrl,
        digest: conversation.digest,
        needsAnalysis: true,
        missingFromLatestExport: false,
        importId,
        updatedAt: serverTimestamp(),
      };

      if (kind === "new") {
        batch.set(conversationRef, { ...content, excluded: false, createdAt: serverTimestamp() });
      } else {
        // `createdAt` and the user's `excluded` choice are left untouched.
        batch.update(conversationRef, content);
      }

      for (const chunk of chunks) {
        batch.set(doc(conversationRef, "chunks", String(chunk.index)), {
          index: chunk.index,
          messages: chunk.messages,
          charCount: chunk.charCount,
          updatedAt: serverTimestamp(),
        });
      }
      const previousChunks = previousChunkCounts.get(conversation.id) ?? 0;
      for (let stale = chunks.length; stale < previousChunks; stale++) {
        batch.delete(doc(conversationRef, "chunks", String(stale)));
      }

      const entries = shardEntries.get(shard) ?? {};
      entries[conversation.id] = conversation.contentHash;
      shardEntries.set(shard, entries);
      index.set(conversation.id, conversation.contentHash);
      writes++;
    }

    if (writes === 0) return this.progress;

    for (const [shard, entries] of shardEntries) {
      batch.set(
        doc(this.db, userPath(this.uid, "sourceIndex", shard)),
        { sourceId, entries, updatedAt: serverTimestamp() },
        { merge: true },
      );
    }
    batch.update(this.importRef(), {
      cursor: this.alreadyWritten + this.written + writes,
      updatedAt: serverTimestamp(),
    });

    await batch.commit();
    this.written += writes;
    return this.progress;
  }

  /** Marks the import complete and refreshes the source's totals. */
  async finish(): Promise<void> {
    const { sourceId, adapterVersion, importId, index } = this.options;
    const sourceRef = doc(this.db, userPath(this.uid, "sources", sourceId));
    const source = await getDoc(sourceRef);
    const batch = writeBatch(this.db);

    batch.update(this.importRef(), {
      status: "completed",
      completedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });

    const totals = {
      adapterVersion,
      lastImportId: importId,
      conversationCount: index.size,
      updatedAt: serverTimestamp(),
    };
    if (source.exists()) batch.update(sourceRef, totals);
    else batch.set(sourceRef, { ...totals, platform: sourceId, createdAt: serverTimestamp() });

    batch.set(doc(collection(this.db, userPath(this.uid, "activityLogs"))), {
      type: "import_completed",
      targetId: importId,
      summary: `Saved ${this.written} conversations.`,
      createdAt: serverTimestamp(),
    });
    await batch.commit();
  }

  /** Records that the import stopped. Best effort; the data already saved is consistent. */
  async markPaused(): Promise<void> {
    const batch = writeBatch(this.db);
    batch.update(this.importRef(), { status: "paused", updatedAt: serverTimestamp() });
    await batch.commit();
  }
}

export type ImportRecord = {
  id: string;
  status: "parsing" | "writing" | "paused" | "completed" | "failed";
  fileNames: string[];
  createdAt: Date | null;
  completedAt: Date | null;
  cursor: number;
  counts: { total: number; new: number; updated: number; unchanged: number; unreadable: number };
};

export async function listImports(db: Firestore, uid: string, max = 20): Promise<ImportRecord[]> {
  const snapshot = await getDocs(
    query(collection(db, userPath(uid, "imports")), orderBy("createdAt", "desc"), limit(max)),
  );
  return snapshot.docs.map((entry) => {
    const data = entry.data();
    const counts = (data.counts ?? {}) as Record<string, unknown>;
    return {
      id: entry.id,
      status: data.status as ImportRecord["status"],
      fileNames: Array.isArray(data.fileNames) ? (data.fileNames as string[]) : [],
      createdAt: toDate(data.createdAt),
      completedAt: toDate(data.completedAt),
      cursor: count(data.cursor),
      counts: {
        total: count(counts.total),
        new: count(counts.new),
        updated: count(counts.updated),
        unchanged: count(counts.unchanged),
        unreadable: count(counts.unreadable),
      },
    };
  });
}

const DELETE_PAGE = 50;
const MAX_DELETE_OPERATIONS = 400;

/**
 * Deletes conversations (with their chunks and index entries) a page at a
 * time. Each page is one atomic batch, so stopping midway leaves the index
 * consistent with what remains, and calling again continues.
 */
async function deleteConversationsWhere(
  db: Firestore,
  uid: string,
  sourceId: string,
  importId: string | null,
  onProgress?: (deleted: number) => void,
): Promise<number> {
  const conversations = collection(db, userPath(uid, "conversations"));
  let deleted = 0;

  for (;;) {
    const page = await getDocs(
      importId === null
        ? query(conversations, where("sourceId", "==", sourceId), limit(DELETE_PAGE))
        : query(conversations, where("importId", "==", importId), limit(DELETE_PAGE)),
    );
    if (page.empty) return deleted;

    const batch = writeBatch(db);
    const shardRemovals = new Map<string, string[]>();
    let operations = 0;
    let removed = 0;
    for (const entry of page.docs) {
      const data = entry.data();
      const chunkCount = count(data.chunkCount);
      // Keep each batch comfortably small; whatever is left is picked up by
      // the next pass of the loop.
      if (removed > 0 && operations + chunkCount + 1 > MAX_DELETE_OPERATIONS) break;
      operations += chunkCount + 1;
      removed++;
      for (let chunk = 0; chunk < chunkCount; chunk++) {
        batch.delete(doc(entry.ref, "chunks", String(chunk)));
      }
      batch.delete(entry.ref);
      const shard = indexShardId(
        String(data.sourceId ?? sourceId),
        String(data.sourceConversationId ?? ""),
      );
      shardRemovals.set(shard, [...(shardRemovals.get(shard) ?? []), entry.id]);
    }
    for (const [shard, ids] of shardRemovals) {
      const removals: unknown[] = [];
      for (const id of ids) removals.push(new FieldPath("entries", id), deleteField());
      const [firstPath, firstValue, ...rest] = removals;
      batch.update(
        doc(db, userPath(uid, "sourceIndex", shard)),
        "updatedAt",
        serverTimestamp(),
        firstPath as FieldPath,
        firstValue,
        ...rest,
      );
    }
    await batch.commit();
    deleted += removed;
    onProgress?.(deleted);
  }
}

/** Removes the conversations last written by one import, and the import record. */
export async function deleteImport(
  db: Firestore,
  uid: string,
  record: Pick<ImportRecord, "id">,
  sourceId: string,
  onProgress?: (deleted: number) => void,
): Promise<number> {
  const deleted = await deleteConversationsWhere(db, uid, sourceId, record.id, onProgress);
  const batch = writeBatch(db);
  batch.delete(doc(db, userPath(uid, "imports", record.id)));
  batch.set(doc(collection(db, userPath(uid, "activityLogs"))), {
    type: "data_deleted",
    targetId: record.id,
    summary: `Deleted ${deleted} conversations from one import.`,
    createdAt: serverTimestamp(),
  });
  await batch.commit();
  return deleted;
}

/** Removes every conversation of a source, its import history and its index. */
export async function deleteSourceData(
  db: Firestore,
  uid: string,
  sourceId: string,
  onProgress?: (deleted: number) => void,
): Promise<number> {
  const deleted = await deleteConversationsWhere(db, uid, sourceId, null, onProgress);

  for (;;) {
    const imports = await getDocs(
      query(collection(db, userPath(uid, "imports")), where("sourceId", "==", sourceId), limit(200)),
    );
    if (imports.empty) break;
    const batch = writeBatch(db);
    for (const entry of imports.docs) batch.delete(entry.ref);
    await batch.commit();
  }

  const batch = writeBatch(db);
  for (const shardId of allIndexShardIds(sourceId)) {
    batch.delete(doc(db, userPath(uid, "sourceIndex", shardId)));
  }
  batch.delete(doc(db, userPath(uid, "sources", sourceId)));
  batch.set(doc(collection(db, userPath(uid, "activityLogs"))), {
    type: "data_deleted",
    targetId: sourceId,
    summary: `Deleted all ${deleted} imported conversations.`,
    createdAt: serverTimestamp(),
  });
  await batch.commit();
  return deleted;
}

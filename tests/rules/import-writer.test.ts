import { readFileSync } from "node:fs";

import { initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { collection, doc, getDoc, getDocs, updateDoc, serverTimestamp, type Firestore } from "firebase/firestore";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { NormalisedConversation } from "../../lib/domain/conversation";
import {
  deleteImport,
  deleteSourceData,
  FirestoreImportWriter,
  listImports,
  loadSourceIndex,
} from "../../lib/import/firestore-writer";
import { parseExport, type ImportResult } from "../../lib/import/parse-export";
import { planImport } from "../../lib/import/plan";
import { asFile, makeConversation, makeConversations, makeExportZip } from "../fixtures/claude-export";

/**
 * The import writer against the Firestore emulator WITH security rules on,
 * as a verified user. Every write the importer makes must therefore be one
 * the rules allow, and the documents must match the validated schema.
 */
const UID = "alice";
let env: RulesTestEnvironment;
let db: Firestore;

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: "demo-recall",
    firestore: { rules: readFileSync("firestore.rules", "utf8") },
  });
  db = env
    .authenticatedContext(UID, { email: "alice@example.com", email_verified: true })
    .firestore() as unknown as Firestore;
});

afterAll(async () => {
  await env.cleanup();
});

beforeEach(async () => {
  await env.clearFirestore();
});

async function parse(raw: unknown[]): Promise<{ result: ImportResult; conversations: NormalisedConversation[] }> {
  const conversations: NormalisedConversation[] = [];
  const result = await parseExport([asFile("conversations-000.zip", await makeExportZip(raw))], {
    onConversation: (conversation) => {
      conversations.push(conversation);
    },
  });
  return { result, conversations };
}

/** Runs a whole import the way the page does: plan, begin, batches of 20, finish. */
async function runImport(raw: unknown[], options: { stopAfterBatches?: number } = {}) {
  const { result, conversations } = await parse(raw);
  const index = await loadSourceIndex(db, UID, "claude");
  const plan = planImport(conversations, index);
  if (plan.new + plan.updated === 0) return { plan, written: 0, importId: result.fingerprint };

  const writer = new FirestoreImportWriter(db, UID, {
    sourceId: "claude",
    adapterVersion: 1,
    importId: result.fingerprint,
    fileNames: ["conversations-000.zip"],
    plan,
    issues: result.issues,
    index,
  });
  await writer.begin();
  let batches = 0;
  for (let start = 0; start < conversations.length; start += 20) {
    if (options.stopAfterBatches !== undefined && batches >= options.stopAfterBatches) {
      return { plan, written: writer.progress.written, importId: result.fingerprint, interrupted: true };
    }
    await writer.writeBatch(conversations.slice(start, start + 20));
    batches++;
  }
  await writer.finish();
  return { plan, written: writer.progress.written, importId: result.fingerprint };
}

const conversationsOf = async () => getDocs(collection(db, `users/${UID}/conversations`));

describe("first import", () => {
  it("saves conversations, chunks, the index, the import record and the source", async () => {
    const raw = makeConversations(45);
    const outcome = await runImport(raw);
    expect(outcome.plan).toMatchObject({ total: 45, new: 45, updated: 0, unchanged: 0 });
    expect(outcome.written).toBe(45);

    const saved = await conversationsOf();
    expect(saved.size).toBe(45);

    const first = raw[0]!;
    const snapshot = await getDoc(doc(db, `users/${UID}/conversations/claude_${first.uuid}`));
    const data = snapshot.data()!;
    expect(data).toMatchObject({
      sourceId: "claude",
      sourceConversationId: first.uuid,
      title: first.name,
      excluded: false,
      needsAnalysis: true,
      importId: outcome.importId,
      sourceUrl: `https://claude.ai/chat/${first.uuid}`,
    });
    expect(data.createdAt.toMillis()).toBeGreaterThan(0);
    expect(data.updatedAtSource.toDate().toISOString()).toBe(first.updated_at);

    const chunks = await getDocs(collection(snapshot.ref, "chunks"));
    expect(chunks.size).toBe(data.chunkCount);
    const stored = chunks.docs.flatMap((chunk) => chunk.data().messages as { text: string }[]);
    expect(stored).toHaveLength(data.messageCount);
    expect(stored[0]!.text).toBe("I will finish the synthetic migration report by Friday.");

    const index = await loadSourceIndex(db, UID, "claude");
    expect(index.size).toBe(45);
    expect(index.get(`claude_${first.uuid}`)).toBe(data.contentHash);

    const [record] = await listImports(db, UID);
    expect(record).toMatchObject({ id: outcome.importId, status: "completed", cursor: 45 });
    expect(record!.counts).toMatchObject({ total: 45, new: 45 });
    expect(record!.completedAt).toBeInstanceOf(Date);

    const source = await getDoc(doc(db, `users/${UID}/sources/claude`));
    expect(source.data()).toMatchObject({ platform: "claude", conversationCount: 45, lastImportId: outcome.importId });
  });

  it("records unreadable conversations on the import without any message text", async () => {
    const raw = [...makeConversations(3), { name: "SYNTHETIC-SECRET", chat_messages: [] }];
    const outcome = await runImport(raw);
    const record = await getDoc(doc(db, `users/${UID}/imports/${outcome.importId}`));
    expect(record.data()!.errors).toHaveLength(1);
    expect(JSON.stringify(record.data())).not.toContain("SYNTHETIC-SECRET");
  });
});

describe("re-import", () => {
  it("plans and writes nothing for an identical export", async () => {
    const raw = makeConversations(25);
    await runImport(raw);
    const before = await conversationsOf();
    const stamps = new Map(before.docs.map((entry) => [entry.id, entry.data().updatedAt.toMillis()]));
    const importsBefore = (await listImports(db, UID)).length;

    const again = await runImport(raw);
    expect(again.plan).toMatchObject({ total: 25, new: 0, updated: 0, unchanged: 25 });
    expect(again.written).toBe(0);

    const after = await conversationsOf();
    expect(after.size).toBe(25);
    for (const entry of after.docs) expect(entry.data().updatedAt.toMillis()).toBe(stamps.get(entry.id));
    expect((await listImports(db, UID)).length).toBe(importsBefore);
  });

  it("writes only new and changed conversations from a newer export", async () => {
    const original = makeConversations(10);
    await runImport(original);
    const untouchedId = `claude_${original[0]!.uuid}`;
    const untouchedBefore = (await getDoc(doc(db, `users/${UID}/conversations/${untouchedId}`))).data()!;

    // Conversation 1 gains turns; two brand-new conversations appear.
    const grown = makeConversation(1, { planted: "brainstorm", branch: false, turns: 12 });
    const newer = [...original.slice(0, 1), grown, ...original.slice(2), makeConversation(100), makeConversation(101)];
    const outcome = await runImport(newer);

    expect(outcome.plan).toMatchObject({ total: 12, new: 2, updated: 1, unchanged: 9 });
    expect(outcome.written).toBe(3);
    expect((await conversationsOf()).size).toBe(12);

    const untouchedAfter = (await getDoc(doc(db, `users/${UID}/conversations/${untouchedId}`))).data()!;
    expect(untouchedAfter.updatedAt.toMillis()).toBe(untouchedBefore.updatedAt.toMillis());
    expect(untouchedAfter.importId).toBe(untouchedBefore.importId);

    const updated = (await getDoc(doc(db, `users/${UID}/conversations/claude_${grown.uuid}`))).data()!;
    expect(updated.messageCount).toBe(24);
    expect(updated.importId).toBe(outcome.importId);
    expect(updated.needsAnalysis).toBe(true);
  });

  it("keeps createdAt and the user's exclusion when a conversation is updated", async () => {
    const original = makeConversation(1, { planted: "commitment", turns: 2 });
    await runImport([original]);
    const ref = doc(db, `users/${UID}/conversations/claude_${original.uuid}`);
    const created = (await getDoc(ref)).data()!.createdAt.toMillis();
    await updateDoc(ref, { excluded: true, updatedAt: serverTimestamp() });

    await runImport([makeConversation(1, { planted: "commitment", turns: 5 })]);
    const data = (await getDoc(ref)).data()!;
    expect(data.messageCount).toBe(10);
    expect(data.excluded).toBe(true);
    expect(data.createdAt.toMillis()).toBe(created);
  });

  it("removes surplus chunks when a conversation shrinks", async () => {
    const long = makeConversation(1, { planted: "commitment", turns: 60, assistantChars: 3_900 });
    long.chat_messages.forEach((message, i) => {
      if (i % 2 === 0) {
        const text = `Synthetic long human message ${i}. ${"word ".repeat(1_500)}`;
        message.text = text;
        (message.content as { text: string }[]).at(-1)!.text = text;
      }
    });
    await runImport([long]);
    const ref = doc(db, `users/${UID}/conversations/claude_${long.uuid}`);
    const chunksBefore = (await getDocs(collection(ref, "chunks"))).size;
    expect(chunksBefore).toBeGreaterThan(1);

    await runImport([makeConversation(1, { planted: "commitment", turns: 2 })]);
    const chunksAfter = await getDocs(collection(ref, "chunks"));
    expect(chunksAfter.size).toBe(1);
    expect((await getDoc(ref)).data()!.chunkCount).toBe(1);
  });
});

describe("interruption and resume", () => {
  it("continues an interrupted import without duplicates or rewrites", async () => {
    const raw = makeConversations(70);
    const partial = await runImport(raw, { stopAfterBatches: 2 });
    expect(partial.interrupted).toBe(true);
    expect((await conversationsOf()).size).toBe(40);
    expect((await listImports(db, UID))[0]).toMatchObject({ status: "writing", cursor: 40 });
    const firstStamp = (await conversationsOf()).docs[0]!.data().updatedAt.toMillis();
    const firstId = (await conversationsOf()).docs[0]!.id;

    const resumed = await runImport(raw);
    expect(resumed.plan).toMatchObject({ total: 70, new: 30, unchanged: 40 });
    expect(resumed.written).toBe(30);
    expect(resumed.importId).toBe(partial.importId);

    const all = await conversationsOf();
    expect(all.size).toBe(70);
    expect(all.docs.find((entry) => entry.id === firstId)!.data().updatedAt.toMillis()).toBe(firstStamp);
    const records = await listImports(db, UID);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ status: "completed", cursor: 70 });
    expect((await loadSourceIndex(db, UID, "claude")).size).toBe(70);
  });
});

describe("deletion", () => {
  it("deletes one import's conversations, chunks and index entries, leaving the rest", async () => {
    const first = makeConversations(8);
    const firstOutcome = await runImport(first);
    const secondOutcome = await runImport([...first, makeConversation(200), makeConversation(201)]);
    expect((await conversationsOf()).size).toBe(10);

    const deleted = await deleteImport(db, UID, { id: secondOutcome.importId }, "claude");
    expect(deleted).toBe(2);
    expect((await conversationsOf()).size).toBe(8);
    expect((await loadSourceIndex(db, UID, "claude")).size).toBe(8);
    expect((await listImports(db, UID)).map((record) => record.id)).toEqual([firstOutcome.importId]);

    // The deleted conversations import again as new.
    const again = await runImport([...first, makeConversation(200), makeConversation(201)]);
    expect(again.plan).toMatchObject({ new: 2, unchanged: 8 });
  });

  it("deletes everything for a source across several pages", async () => {
    await runImport(makeConversations(120));
    const deleted = await deleteSourceData(db, UID, "claude");
    expect(deleted).toBe(120);
    expect((await conversationsOf()).size).toBe(0);
    expect((await loadSourceIndex(db, UID, "claude")).size).toBe(0);
    expect(await listImports(db, UID)).toHaveLength(0);
    expect((await getDoc(doc(db, `users/${UID}/sources/claude`))).exists()).toBe(false);

    let chunkLeftovers = -1;
    await env.withSecurityRulesDisabled(async (context) => {
      chunkLeftovers = (await context.firestore().collectionGroup("chunks").get()).size;
    });
    expect(chunkLeftovers).toBe(0);
  });
});

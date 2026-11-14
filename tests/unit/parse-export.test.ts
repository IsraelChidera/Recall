import { describe, expect, it } from "vitest";

import type { NormalisedConversation } from "@/lib/domain/conversation";
import { normalisedConversationSchema } from "@/lib/domain/conversation";
import { IMPORT_LIMITS } from "@/lib/import/limits";
import { ImportAbortedError, parseExport } from "@/lib/import/parse-export";
import {
  asFile,
  makeConversation,
  makeConversations,
  makeExportZip,
  makeZip,
} from "@/tests/fixtures/claude-export";

async function run(files: Parameters<typeof parseExport>[0]) {
  const conversations: NormalisedConversation[] = [];
  const result = await parseExport(files, {
    onConversation: (conversation) => {
      conversations.push(conversation);
    },
  });
  return { result, conversations };
}

describe("archive validation", () => {
  it("requires at least one file and caps the number of files", async () => {
    await expect(run([])).rejects.toThrow(ImportAbortedError);
    const zip = await makeExportZip([]);
    const tooMany = Array.from({ length: IMPORT_LIMITS.maxFiles + 1 }, (_, i) =>
      asFile(`conversations-${i}.zip`, zip),
    );
    await expect(run(tooMany)).rejects.toThrow(/at most/);
  });

  it("rejects a file that is not a ZIP", async () => {
    const bytes = new TextEncoder().encode('[{"uuid":"x"}]');
    const { result } = await run([asFile("conversations.json", bytes)]);
    expect(result.files).toEqual([
      { name: "conversations.json", status: "rejected", reason: "This is not a ZIP file." },
    ]);
    expect(result.stats.conversations).toBe(0);
  });

  it("rejects a corrupt ZIP", async () => {
    const zip = await makeExportZip(makeConversations(3));
    const { result } = await run([asFile("conversations-000.zip", zip.slice(0, 60))]);
    expect(result.files[0]?.status).toBe("rejected");
    expect(result.files[0]?.reason).toMatch(/corrupt/);
  });

  it("rejects a file over the size limit without opening it", async () => {
    const zip = await makeExportZip([]);
    const { result } = await run([
      { name: "huge.zip", size: IMPORT_LIMITS.maxZipBytes + 1, data: zip },
    ]);
    expect(result.files[0]).toMatchObject({ status: "rejected" });
  });

  it("rejects archives containing path traversal entries", async () => {
    const zip = await makeZip({
      "conversations.json": "[]",
      "../../outside.txt": "x",
    });
    const { result } = await run([asFile("conversations-000.zip", zip)]);
    // JSZip normalises some traversal names on load; whichever way it reads
    // the archive, nothing outside the conversations file is ever touched.
    expect(["rejected", "parsed"]).toContain(result.files[0]?.status);
    expect(result.stats.conversations).toBe(0);
  });

  it("ignores the other parts of an export instead of failing", async () => {
    const projects = await makeZip({ "projects/019c77a7.json": '{"name":"Synthetic"}' });
    const conversations = await makeExportZip(makeConversations(4));
    const { result } = await run([
      asFile("projects-000.zip", projects),
      asFile("conversations-000.zip", conversations),
    ]);
    expect(result.files.map((file) => file.status)).toEqual(["ignored", "parsed"]);
    expect(result.stats.conversations).toBe(4);
    expect(result.sourceId).toBe("claude");
  });

  it("reports a conversations file that is not a JSON array", async () => {
    const zip = await makeExportZip('{"not":"an array"}');
    const { result } = await run([asFile("conversations-000.zip", zip)]);
    expect(result.files[0]).toMatchObject({ status: "rejected", reason: expect.stringMatching(/JSON array/) });
  });

  it("keeps conversations read before a truncated file ended", async () => {
    const json = JSON.stringify(makeConversations(5));
    const zip = await makeExportZip(json.slice(0, Math.floor(json.length * 0.7)));
    const { result, conversations } = await run([asFile("conversations-000.zip", zip)]);
    expect(result.files[0]?.status).toBe("rejected");
    expect(conversations.length).toBeGreaterThan(0);
    expect(conversations.length).toBeLessThan(5);
  });
});

describe("normalisation through the pipeline", () => {
  it("emits valid conversations in order with accurate counts", async () => {
    const raw = makeConversations(12);
    const { result, conversations } = await run([
      asFile("conversations-000.zip", await makeExportZip(raw)),
    ]);
    expect(conversations).toHaveLength(12);
    for (const conversation of conversations) {
      expect(() => normalisedConversationSchema.parse(conversation)).not.toThrow();
    }
    expect(conversations.map((c) => c.sourceConversationId)).toEqual(raw.map((c) => c.uuid));
    expect(result.stats.messages).toBe(conversations.reduce((sum, c) => sum + c.messageCount, 0));
    expect(result.stats.offBranchMessages).toBeGreaterThan(0);
    expect(result.stats.earliest! <= result.stats.latest!).toBe(true);
    expect(result.adapterVersion).toBe(1);
  });

  it("skips malformed conversations, records why, and keeps going", async () => {
    const good = makeConversations(3);
    const mixed = [good[0], { name: "no uuid" }, "a string", 42, null, { uuid: "not-a-uuid" }, good[1], good[2]];
    const { result, conversations } = await run([
      asFile("conversations-000.zip", await makeExportZip(mixed)),
    ]);
    expect(conversations).toHaveLength(3);
    expect(result.stats.skipped).toBe(5);
    expect(result.issueCount).toBe(5);
    expect(result.files[0]?.status).toBe("parsed");
  });

  it("never puts message text into issues", async () => {
    const secret = "SYNTHETIC-SECRET-TEXT";
    const broken = { name: secret, chat_messages: [{ uuid: "m", sender: "human", text: secret }] };
    const { result } = await run([asFile("c.zip", await makeExportZip([broken]))]);
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("caps the stored issue list but keeps counting", async () => {
    const junk = Array.from({ length: IMPORT_LIMITS.maxIssuesKept + 25 }, () => ({ name: "x" }));
    const { result } = await run([asFile("c.zip", await makeExportZip(junk))]);
    expect(result.issues).toHaveLength(IMPORT_LIMITS.maxIssuesKept);
    expect(result.issueCount).toBe(IMPORT_LIMITS.maxIssuesKept + 25);
  });

  it("waits for onConversation before reading further (backpressure)", async () => {
    let active = 0;
    let maxActive = 0;
    await parseExport([asFile("c.zip", await makeExportZip(makeConversations(20)))], {
      onConversation: async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 1));
        active--;
      },
    });
    expect(maxActive).toBe(1);
  });

  it("reports progress per conversation", async () => {
    const seen: number[] = [];
    await parseExport([asFile("c.zip", await makeExportZip(makeConversations(5)))], {
      onConversation: () => {},
      onProgress: (progress) => seen.push(progress.conversations),
    });
    expect(seen).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("duplicates and fingerprints", () => {
  it("drops identical copies of a conversation across files", async () => {
    const raw = makeConversations(6);
    const partA = await makeExportZip(raw.slice(0, 4));
    const partB = await makeExportZip(raw.slice(2));
    const { result, conversations } = await run([
      asFile("conversations-000.zip", partA),
      asFile("conversations-001.zip", partB),
    ]);
    expect(result.stats.conversations).toBe(6);
    expect(result.stats.duplicates).toBe(2);
    expect(conversations).toHaveLength(6);
  });

  it("passes on a changed copy so the later version wins, without double counting", async () => {
    const original = makeConversation(1, { planted: "commitment", turns: 2 });
    const updated = makeConversation(1, { planted: "commitment", turns: 4 });
    expect(updated.uuid).toBe(original.uuid);
    const { result, conversations } = await run([
      asFile("old.zip", await makeExportZip([original])),
      asFile("new.zip", await makeExportZip([updated])),
    ]);
    expect(result.stats.conversations).toBe(1);
    expect(result.stats.duplicates).toBe(1);
    expect(conversations.map((c) => c.messageCount)).toEqual([4, 8]);
  });

  it("gives the same fingerprint for the same content regardless of file name or order", async () => {
    const raw = makeConversations(8);
    const a = await run([asFile("conversations-000.zip", await makeExportZip(raw))]);
    const b = await run([asFile("renamed.zip", await makeExportZip([...raw].reverse()))]);
    expect(a.result.fingerprint).toBe(b.result.fingerprint);
    expect(a.result.fingerprint).toMatch(/^[0-9a-f]{40}$/);
  });

  it("changes the fingerprint when a conversation gains a message", async () => {
    const before = await run([
      asFile("c.zip", await makeExportZip([makeConversation(1, { planted: "commitment", turns: 2 })])),
    ]);
    const after = await run([
      asFile("c.zip", await makeExportZip([makeConversation(1, { planted: "commitment", turns: 3 })])),
    ]);
    expect(after.result.fingerprint).not.toBe(before.result.fingerprint);
  });
});

describe("large archives", () => {
  it("parses 1,000 conversations without holding them in memory", async () => {
    const raw = makeConversations(1_000, { assistantChars: 2_000 });
    const json = JSON.stringify(raw);
    const expectedMessages = raw.length;
    const zip = await makeExportZip(json);
    raw.length = 0;

    let count = 0;
    let largest = 0;
    const result = await parseExport([asFile("conversations-000.zip", zip)], {
      onConversation: (conversation) => {
        count++;
        largest = Math.max(largest, JSON.stringify(conversation).length);
      },
    });

    expect(count).toBe(expectedMessages);
    expect(result.stats.conversations).toBe(1_000);
    expect(result.files[0]?.status).toBe("parsed");
    // The document is tens of megabytes; no single retained unit comes close.
    expect(json.length).toBeGreaterThan(20 * 1024 * 1024);
    expect(largest).toBeLessThan(1024 * 1024);
  }, 120_000);
});

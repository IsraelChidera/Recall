import { describe, expect, it } from "vitest";

import type { NormalisedMessage } from "@/lib/domain/conversation";
import {
  allIndexShardIds,
  CHUNK_LIMITS,
  chunkMessages,
  classify,
  INDEX_SHARDS,
  indexShardId,
  planImport,
} from "@/lib/import/plan";

const message = (id: string, length: number): NormalisedMessage => ({
  id,
  sender: "human",
  createdAt: null,
  text: "x".repeat(length),
  truncated: false,
  attachmentCount: 2,
  toolUseCount: 3,
});

describe("classify and planImport", () => {
  const index = new Map([
    ["claude_a", "hash-a"],
    ["claude_b", "hash-b"],
    ["claude_gone", "hash-gone"],
  ]);

  it("classifies against the saved index", () => {
    expect(classify({ id: "claude_a", contentHash: "hash-a" }, index)).toBe("unchanged");
    expect(classify({ id: "claude_b", contentHash: "changed" }, index)).toBe("updated");
    expect(classify({ id: "claude_c", contentHash: "hash-c" }, index)).toBe("new");
  });

  it("counts new, updated, unchanged and conversations absent from the export", () => {
    const plan = planImport(
      [
        { id: "claude_a", contentHash: "hash-a" },
        { id: "claude_b", contentHash: "changed" },
        { id: "claude_c", contentHash: "hash-c" },
      ],
      index,
    );
    expect(plan).toEqual({ total: 3, new: 1, updated: 1, unchanged: 1, notInThisExport: 1 });
  });

  it("plans nothing to write for an identical re-import", () => {
    const same = [...index].map(([id, contentHash]) => ({ id, contentHash }));
    const plan = planImport(same, index);
    expect(plan.new + plan.updated).toBe(0);
    expect(plan.unchanged).toBe(3);
  });

  it("counts a conversation once when it appears twice, using the last copy", () => {
    const plan = planImport(
      [
        { id: "claude_a", contentHash: "older" },
        { id: "claude_a", contentHash: "hash-a" },
      ],
      index,
    );
    expect(plan).toMatchObject({ total: 1, unchanged: 1, updated: 0 });
  });
});

describe("index shards", () => {
  it("is deterministic and spreads ids over a fixed set of documents", () => {
    const ids = "0123456789abcdef".split("").map((c) => `${c}f0c7b2e-14d9-4a3e-b8c6-91e2f7a0d435`);
    const shards = new Set(ids.map((id) => indexShardId("claude", id)));
    expect(shards.size).toBe(INDEX_SHARDS);
    expect([...shards].every((shard) => allIndexShardIds("claude").includes(shard))).toBe(true);
    expect(indexShardId("claude", ids[3]!)).toBe(indexShardId("claude", ids[3]!));
  });

  it("falls back to the first shard for an id that is not hexadecimal", () => {
    expect(indexShardId("claude", "zzz")).toBe("claude_0");
    expect(indexShardId("claude", "")).toBe("claude_0");
  });
});

describe("chunkMessages", () => {
  it("returns no chunks for an empty conversation", () => {
    expect(chunkMessages([])).toEqual([]);
  });

  it("keeps a small conversation in one chunk and stores only message fields", () => {
    const chunks = chunkMessages([message("m1", 10), message("m2", 20)]);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ index: 0, charCount: 30 });
    expect(Object.keys(chunks[0]!.messages[0]!).sort()).toEqual(
      ["createdAt", "id", "sender", "text", "truncated"].sort(),
    );
  });

  it("splits on the character limit, preserving order and losing nothing", () => {
    const messages = Array.from({ length: 10 }, (_, i) => message(`m${i}`, 50_000));
    const chunks = chunkMessages(messages);
    expect(chunks.map((chunk) => chunk.index)).toEqual(chunks.map((_, i) => i));
    expect(chunks.flatMap((chunk) => chunk.messages.map((m) => m.id))).toEqual(messages.map((m) => m.id));
    for (const chunk of chunks) {
      expect(chunk.charCount).toBeLessThanOrEqual(CHUNK_LIMITS.characters);
      expect(chunk.messages.length).toBeGreaterThan(0);
    }
    expect(chunks.length).toBe(4);
  });

  it("splits on the message-count limit", () => {
    const messages = Array.from({ length: CHUNK_LIMITS.messages + 1 }, (_, i) => message(`m${i}`, 1));
    expect(chunkMessages(messages).map((chunk) => chunk.messages.length)).toEqual([CHUNK_LIMITS.messages, 1]);
  });

  it("gives an oversize message a chunk of its own instead of dropping it", () => {
    const chunks = chunkMessages([message("small", 10), message("huge", CHUNK_LIMITS.characters + 5), message("after", 10)]);
    expect(chunks.map((chunk) => chunk.messages.map((m) => m.id))).toEqual([["small"], ["huge"], ["after"]]);
  });
});

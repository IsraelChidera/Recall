import { describe, expect, it } from "vitest";

import { ASSISTANT_TEXT_LIMIT, normalisedConversationSchema } from "@/lib/domain/conversation";
import { activeBranch, claudeAdapter } from "@/lib/sources/claude/adapter";

import { makeConversation } from "../fixtures/claude-export";

async function normalise(raw: unknown) {
  const result = await claudeAdapter.normalise(raw);
  if (!result.ok) throw new Error(`expected ok, got: ${result.reason}`);
  return result.conversation;
}

describe("claudeAdapter.conversationEntries", () => {
  it("finds conversations files at the root, in folders and in numbered parts", () => {
    expect(claudeAdapter.conversationEntries(["conversations.json"])).toEqual(["conversations.json"]);
    expect(
      claudeAdapter.conversationEntries(["x/conversations.json", "conversations-001.json", "users.json"]),
    ).toEqual(["x/conversations.json", "conversations-001.json"]);
  });

  it("ignores the other parts of an export", () => {
    expect(
      claudeAdapter.conversationEntries([
        "users.json",
        "login_history.json",
        "projects/abc.json",
        "memories/abc.json",
        "design_chats/abc.json",
        "my-conversations.json.bak",
      ]),
    ).toEqual([]);
  });
});

describe("claudeAdapter.normalise", () => {
  it("produces a valid normalised conversation", async () => {
    const raw = makeConversation(1, { planted: "commitment", turns: 4 });
    const conversation = await normalise(raw);
    expect(normalisedConversationSchema.safeParse(conversation).success).toBe(true);
    expect(conversation.id).toBe(`claude_${raw.uuid}`);
    expect(conversation.sourceUrl).toBe(`https://claude.ai/chat/${raw.uuid}`);
    expect(conversation.messageCount).toBe(8);
    expect(conversation.humanMessageCount).toBe(4);
    expect(conversation.messages[0]?.text).toBe("I will finish the synthetic migration report by Friday.");
    expect(conversation.messages.map((m) => m.sender).slice(0, 2)).toEqual(["human", "assistant"]);
  });

  it("keeps visible text and drops thinking, tool calls and tool output", async () => {
    const conversation = await normalise(makeConversation(2, { planted: "commitment", turns: 2 }));
    const assistant = conversation.messages.find((m) => m.sender === "assistant");
    expect(assistant?.text.startsWith("Synthetic answer 0.")).toBe(true);
    expect(assistant?.text).not.toContain("synthetic tool output");
    expect(assistant?.toolUseCount).toBe(1);
  });

  it("truncates long assistant replies and keeps human messages whole", async () => {
    const raw = makeConversation(3, { planted: "commitment", turns: 1, assistantChars: 9_000 });
    (raw.chat_messages[0] as unknown as { content: { text: string }[] }).content[0]!.text = "h".repeat(9_000);
    const conversation = await normalise(raw);
    const [human, assistant] = conversation.messages;
    expect(human?.text.length).toBe(9_000);
    expect(human?.truncated).toBe(false);
    expect(assistant?.text.length).toBe(ASSISTANT_TEXT_LIMIT);
    expect(assistant?.truncated).toBe(true);
  });

  it("follows the latest branch and counts superseded messages", async () => {
    const raw = makeConversation(4, { planted: "commitment", turns: 3, branch: true });
    expect(raw.chat_messages).toHaveLength(8);
    const conversation = await normalise(raw);
    expect(conversation.messageCount).toBe(6);
    expect(conversation.offBranchMessageCount).toBe(2);
    expect(conversation.messages.some((m) => m.text.includes("abandoned"))).toBe(false);
    const senders = conversation.messages.map((m) => m.sender);
    expect(senders).toEqual(["human", "assistant", "human", "assistant", "human", "assistant"]);
  });

  it("falls back to the flat text field when a message has no content blocks", async () => {
    const raw = makeConversation(5, { planted: "commitment", turns: 1 });
    const first = raw.chat_messages[0] as Record<string, unknown>;
    first.content = [];
    first.text = "Flat text only.";
    expect((await normalise(raw)).messages[0]?.text).toBe("Flat text only.");
  });

  it("handles missing optional fields", async () => {
    const conversation = await normalise({
      uuid: "5f0c7b2e-14d9-4a3e-b8c6-91e2f7a0d435",
      chat_messages: [{ uuid: "m1", sender: "human", text: "Only the essentials." }],
    });
    expect(conversation.title).toBe("");
    expect(conversation.createdAtSource).toBeNull();
    expect(conversation.updatedAtSource).toBeNull();
    expect(conversation.messages[0]?.createdAt).toBeNull();
    expect(conversation.messageCount).toBe(1);
  });

  it("tolerates wrong types in optional fields and drops only the broken message", async () => {
    const conversation = await normalise({
      uuid: "5f0c7b2e-14d9-4a3e-b8c6-91e2f7a0d435",
      name: 12345,
      created_at: "not a date",
      chat_messages: [
        { uuid: "m1", sender: "human", text: "Kept.", content: "not an array", attachments: 7 },
        { sender: "human", text: "No uuid, dropped." },
        "not an object",
        { uuid: "m2", sender: "system", text: "Unknown sender, dropped." },
      ],
    });
    expect(conversation.title).toBe("");
    expect(conversation.createdAtSource).toBeNull();
    expect(conversation.messages.map((m) => m.text)).toEqual(["Kept."]);
  });

  it("accepts a conversation with no messages", async () => {
    const conversation = await normalise({ uuid: "5f0c7b2e-14d9-4a3e-b8c6-91e2f7a0d435", chat_messages: [] });
    expect(conversation.messageCount).toBe(0);
  });

  it.each([
    ["a non-object", "nope"],
    ["a missing uuid", { name: "x", chat_messages: [] }],
    ["a uuid that is not a UUID", { uuid: "../../users/bob", chat_messages: [] }],
  ])("rejects %s without throwing", async (_label, raw) => {
    const result = await claudeAdapter.normalise(raw);
    expect(result.ok).toBe(false);
  });

  it("builds a digest from the title, summary and first and last human messages", async () => {
    const conversation = await normalise(makeConversation(7, { planted: "completed", turns: 3 }));
    expect(conversation.digest).toContain("Title: Synthetic completed conversation 7");
    expect(conversation.digest).toContain("Summary: Synthetic summary");
    expect(conversation.digest).toContain("First request: I need to send the synthetic invoice");
    expect(conversation.digest).toContain("Latest request: Done, I sent the synthetic invoice");
    expect(conversation.digest.length).toBeLessThanOrEqual(4_000);
  });

  it("gives the same hash for the same content and a new hash when it changes", async () => {
    const base = makeConversation(8, { planted: "commitment", turns: 2 });
    const same = await normalise(structuredClone(base));
    expect((await normalise(base)).contentHash).toBe(same.contentHash);

    const grown = makeConversation(8, { planted: "commitment", turns: 3 });
    expect((await normalise(grown)).contentHash).not.toBe(same.contentHash);

    const touched = { ...structuredClone(base), updated_at: "2027-01-01T00:00:00.000Z" };
    expect((await normalise(touched)).contentHash).not.toBe(same.contentHash);
  });
});

describe("activeBranch", () => {
  const message = (uuid: string, parent: string, created_at: string) => ({
    uuid,
    parent_message_uuid: parent,
    created_at,
    sender: "human",
    text: uuid,
    content: null,
    attachments: null,
    files: null,
  });

  it("returns export order when parent links are circular", () => {
    const loop = [message("a", "b", "2026-01-01T00:00:00Z"), message("b", "a", "2026-01-01T00:01:00Z")];
    expect(activeBranch(loop).map((m) => m.uuid)).toEqual(["a", "b"]);
  });

  it("picks the branch whose leaf is most recent", () => {
    const tree = [
      message("root", "none", "2026-01-01T00:00:00Z"),
      message("old", "root", "2026-01-01T00:01:00Z"),
      message("new", "root", "2026-01-01T00:02:00Z"),
      message("new-reply", "new", "2026-01-01T00:03:00Z"),
    ];
    expect(activeBranch(tree).map((m) => m.uuid)).toEqual(["root", "new", "new-reply"]);
  });
});

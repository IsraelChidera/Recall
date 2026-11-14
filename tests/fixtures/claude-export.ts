import JSZip from "jszip";

/**
 * Synthetic Claude exports shaped like the real one (manifest version 1.0).
 * Everything is generated from a seed, so tests are deterministic and no real
 * conversation is ever needed.
 */
const ROOT_PARENT = "00000000-0000-4000-8000-000000000000";

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function uuidFrom(random: () => number): string {
  const hex = (length: number) =>
    Array.from({ length }, () => Math.floor(random() * 16).toString(16)).join("");
  return `${hex(8)}-${hex(4)}-4${hex(3)}-8${hex(3)}-${hex(12)}`;
}

const WORDS =
  "plan report draft review budget launch client deck schema import parser thesis chapter outline invoice migration dashboard research proposal timeline".split(
    " ",
  );

function sentence(random: () => number, words: number): string {
  return Array.from({ length: words }, () => WORDS[Math.floor(random() * WORDS.length)]).join(" ");
}

/** What the generator planted, so later milestones can score extraction against it. */
export type PlantedKind = "commitment" | "brainstorm" | "completed" | "trivial";

const PLANTED_TEXT: Record<Exclude<PlantedKind, "trivial">, { human: string; later?: string }> = {
  commitment: { human: "I will finish the synthetic migration report by Friday." },
  brainstorm: { human: "Just thinking out loud: maybe one day a synthetic bakery app could work." },
  completed: {
    human: "I need to send the synthetic invoice to the client this week.",
    later: "Done, I sent the synthetic invoice to the client yesterday.",
  },
};

export type SyntheticOptions = {
  seed?: number;
  /** Turn pairs (human + assistant). Default 3 to 20, seeded. */
  turns?: number;
  /** Characters of filler per assistant reply. */
  assistantChars?: number;
  planted?: PlantedKind;
  /** Adds an abandoned sibling branch after the first turn. */
  branch?: boolean;
  name?: string;
  uuid?: string;
  updatedAt?: string;
};

export type SyntheticMessage = Record<string, unknown> & { uuid: string };
export type SyntheticConversation = Record<string, unknown> & {
  uuid: string;
  chat_messages: SyntheticMessage[];
};

export function makeConversation(index: number, options: SyntheticOptions = {}): SyntheticConversation {
  const random = mulberry32((options.seed ?? 1) * 7919 + index);
  const uuid = options.uuid ?? uuidFrom(random);
  const planted = options.planted ?? "trivial";
  const turns = options.turns ?? (planted === "trivial" ? 1 : 3 + Math.floor(random() * 18));
  const start = Date.UTC(2026, 1, 1) + index * 3_600_000;
  const messages: SyntheticMessage[] = [];
  let parent = ROOT_PARENT;
  let clock = start;

  const push = (sender: "human" | "assistant", text: string, extraBlocks: unknown[] = []) => {
    clock += 60_000;
    const stamp = new Date(clock).toISOString().replace("Z", "000Z");
    const id = uuidFrom(random);
    messages.push({
      uuid: id,
      text,
      content: [
        ...extraBlocks,
        { type: "text", text, start_timestamp: stamp, stop_timestamp: stamp, citations: [], flags: null },
      ],
      sender,
      created_at: stamp,
      updated_at: stamp,
      attachments: [],
      files: [],
      parent_message_uuid: parent,
    });
    parent = id;
    return id;
  };

  for (let turn = 0; turn < turns; turn++) {
    const plantedText = planted === "trivial" ? undefined : PLANTED_TEXT[planted];
    const human =
      turn === 0 && plantedText
        ? plantedText.human
        : turn === turns - 1 && plantedText?.later
          ? plantedText.later
          : `Synthetic question ${turn}: ${sentence(random, 12)}?`;
    const parentBeforeTurn = parent;
    push("human", human);

    if (options.branch && turn === 1) {
      // An edited prompt: an older sibling that was superseded.
      const keep = parent;
      const keptMessage = messages.pop() as SyntheticMessage;
      parent = parentBeforeTurn;
      clock -= 120_000;
      const abandoned = push("human", "Synthetic abandoned wording of the question.");
      parent = abandoned;
      push("assistant", "Synthetic abandoned answer.");
      clock += 120_000;
      messages.push(keptMessage);
      parent = keep;
    }

    const filler = sentence(random, Math.ceil((options.assistantChars ?? 1_200) / 8));
    push("assistant", `Synthetic answer ${turn}. ${filler}`, [
      { type: "thinking", thinking: "", summaries: [], cut_off: false, signature: null },
      { type: "tool_use", name: "synthetic_tool", input: { query: "synthetic" }, id: `toolu_${turn}` },
      {
        type: "tool_result",
        name: "synthetic_tool",
        is_error: false,
        content: [{ type: "text", text: `synthetic tool output ${sentence(random, 30)}` }],
      },
    ]);
  }

  return {
    uuid,
    name: options.name ?? `Synthetic ${planted} conversation ${index}`,
    summary: index % 3 === 0 ? "" : `Synthetic summary: ${sentence(random, 20)}.`,
    created_at: new Date(start).toISOString(),
    updated_at: options.updatedAt ?? new Date(clock).toISOString(),
    account: { uuid: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
    chat_messages: messages,
  };
}

const KINDS: PlantedKind[] = ["commitment", "brainstorm", "completed", "trivial"];

export function makeConversations(count: number, options: SyntheticOptions = {}): SyntheticConversation[] {
  return Array.from({ length: count }, (_, index) =>
    makeConversation(index, {
      ...options,
      planted: options.planted ?? KINDS[index % KINDS.length],
      branch: options.branch ?? index % 5 === 0,
    }),
  );
}

/** Builds a ZIP like `conversations-000.zip`: one conversations.json at the root. */
export async function makeExportZip(
  conversations: unknown[] | string,
  entryName = "conversations.json",
): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file(entryName, typeof conversations === "string" ? conversations : JSON.stringify(conversations));
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}

export async function makeZip(entries: Record<string, string>): Promise<Uint8Array> {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(entries)) zip.file(name, content);
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}

export function asFile(name: string, data: Uint8Array) {
  return { name, size: data.byteLength, data };
}

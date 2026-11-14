import type { NormalisedConversation } from "@/lib/domain/conversation";
import { ImportAbortedError, parseExport } from "@/lib/import/parse-export";
import {
  BATCH_LIMITS,
  type ImportWorkerRequest,
  type ImportWorkerResponse,
} from "@/lib/import/protocol";

/**
 * Parses export archives off the main thread. Conversations are handed to the
 * page in small batches, and the worker waits for an acknowledgement before
 * reading further, so neither side ever holds the whole export.
 */
type WorkerScope = {
  postMessage(message: ImportWorkerResponse): void;
  onmessage: ((event: MessageEvent<ImportWorkerRequest>) => void) | null;
};

const scope = self as unknown as WorkerScope;

let acknowledge: (() => void) | null = null;
let running = false;

function send(message: ImportWorkerResponse): void {
  scope.postMessage(message);
}

function sendBatch(conversations: NormalisedConversation[]): Promise<void> {
  return new Promise((resolve) => {
    acknowledge = resolve;
    send({ type: "batch", conversations });
  });
}

async function run(files: File[]): Promise<void> {
  let batch: NormalisedConversation[] = [];
  let characters = 0;
  let lastProgress = 0;

  const flush = async () => {
    if (batch.length === 0) return;
    const ready = batch;
    batch = [];
    characters = 0;
    await sendBatch(ready);
  };

  const result = await parseExport(
    files.map((file) => ({ name: file.name, size: file.size, data: file })),
    {
      onConversation: async (conversation) => {
        batch.push(conversation);
        for (const message of conversation.messages) characters += message.text.length;
        if (batch.length >= BATCH_LIMITS.conversations || characters >= BATCH_LIMITS.characters) {
          await flush();
        }
      },
      onProgress: (progress) => {
        // At most ten updates a second keeps the page responsive.
        const now = Date.now();
        if (now - lastProgress < 100) return;
        lastProgress = now;
        send({ type: "progress", progress });
      },
    },
  );

  await flush();
  send({ type: "done", result });
}

scope.onmessage = (event) => {
  const message = event.data;
  if (message.type === "ack") {
    const resolve = acknowledge;
    acknowledge = null;
    resolve?.();
    return;
  }
  if (message.type === "start") {
    if (running) return;
    running = true;
    run(message.files).catch((error: unknown) => {
      send({
        type: "error",
        message:
          error instanceof ImportAbortedError
            ? error.message
            : "The import stopped unexpectedly. Nothing was saved. Try again.",
      });
    });
  }
};

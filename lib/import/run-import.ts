import type { NormalisedConversation } from "@/lib/domain/conversation";

import type { ImportProgress, ImportResult } from "./parse-export";
import type { ImportWorkerRequest, ImportWorkerResponse } from "./protocol";

export type RunImportHandlers = {
  /**
   * Receives conversations in order, a batch at a time. The worker reads no
   * further until the returned promise settles, so a slow consumer (a
   * Firestore writer) applies backpressure all the way to the ZIP reader.
   */
  onBatch: (conversations: NormalisedConversation[]) => void | Promise<void>;
  onProgress?: (progress: ImportProgress) => void;
};

export type ImportRun = {
  result: Promise<ImportResult>;
  /** Stops the worker. The result promise rejects. */
  cancel: () => void;
};

export class ImportCancelledError extends Error {
  constructor() {
    super("Import cancelled.");
    this.name = "ImportCancelledError";
  }
}

/** Parses the given export files in a Web Worker. Browser only. */
export function runImport(files: File[], handlers: RunImportHandlers): ImportRun {
  const worker = new Worker(new URL("../../workers/import.worker.ts", import.meta.url), {
    type: "module",
  });
  const post = (message: ImportWorkerRequest) => worker.postMessage(message);
  let settled = false;
  let rejectResult: (error: Error) => void = () => {};

  const result = new Promise<ImportResult>((resolve, reject) => {
    rejectResult = reject;
    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      worker.terminate();
      settle();
    };

    worker.onmessage = (event: MessageEvent<ImportWorkerResponse>) => {
      const message = event.data;
      switch (message.type) {
        case "progress":
          handlers.onProgress?.(message.progress);
          break;
        case "batch":
          Promise.resolve(handlers.onBatch(message.conversations)).then(
            () => {
              if (!settled) post({ type: "ack" });
            },
            (error: unknown) =>
              finish(() => reject(error instanceof Error ? error : new Error("Import failed."))),
          );
          break;
        case "done":
          finish(() => resolve(message.result));
          break;
        case "error":
          finish(() => reject(new Error(message.message)));
          break;
      }
    };
    worker.onerror = () =>
      finish(() => reject(new Error("The import stopped unexpectedly. Nothing was saved.")));
  });

  post({ type: "start", files });

  return {
    result,
    cancel: () => {
      if (settled) return;
      settled = true;
      worker.terminate();
      rejectResult(new ImportCancelledError());
    },
  };
}

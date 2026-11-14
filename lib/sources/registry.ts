import { claudeAdapter } from "./claude/adapter";
import type { SourceAdapter } from "./types";

/** Every supported platform. A ChatGPT adapter would be added here. */
export const sourceAdapters: readonly SourceAdapter[] = [claudeAdapter];

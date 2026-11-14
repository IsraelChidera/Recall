import "server-only";

import { getAIConfig, type AIConfig } from "./config";
import { FakeProvider } from "./fake";
import { GeminiProvider } from "./gemini";
import type { AIProvider } from "./provider";

export class AINotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AINotConfiguredError";
  }
}

let cached: { provider: AIProvider; key: string } | undefined;

/** The configured provider. The stand-in is allowed only outside deployed production. */
export function getAIProvider(config: AIConfig = getAIConfig()): AIProvider {
  const key = `${config.provider}|${config.bulkModel}|${config.qualityModel}`;
  if (cached?.key === key) return cached.provider;

  let provider: AIProvider;
  if (config.provider === "fake") {
    if (process.env.VERCEL) {
      throw new AINotConfiguredError("The stand-in AI provider cannot be used on a deployed site.");
    }
    provider = new FakeProvider();
  } else {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new AINotConfiguredError("GEMINI_API_KEY is not set on the server.");
    }
    provider = GeminiProvider.fromApiKey(apiKey, {
      bulk: config.bulkModel,
      quality: config.qualityModel,
    });
  }
  cached = { provider, key };
  return provider;
}

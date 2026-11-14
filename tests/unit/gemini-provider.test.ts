import { ApiError } from "@google/genai";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { GeminiProvider, type GeminiClient } from "@/lib/ai/gemini";
import { AIRateLimitError, AIResponseError, AIUnavailableError } from "@/lib/ai/provider";

const schema = z.object({ answer: z.string() });
const request = { role: "bulk" as const, system: "system text", prompt: "prompt text", schema };
const models = { bulk: "bulk-model", quality: "quality-model" };

function provider(generateContent: GeminiClient["models"]["generateContent"]) {
  const spy = vi.fn(generateContent);
  return { spy, provider: new GeminiProvider({ models: { generateContent: spy } }, models) };
}

const apiError = (status: number, message: string) => new ApiError({ status, message });

describe("GeminiProvider", () => {
  it("requests JSON with the schema and returns validated data and usage", async () => {
    const { spy, provider: gemini } = provider(async () => ({
      text: '{"answer":"yes"}',
      usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 8 },
    }));
    const response = await gemini.generateStructured(request);
    expect(response).toEqual({ data: { answer: "yes" }, model: "bulk-model", usage: { inputTokens: 120, outputTokens: 8 } });
    const args = spy.mock.calls[0]![0];
    expect(args.model).toBe("bulk-model");
    expect(args.contents).toBe("prompt text");
    expect(args.config).toMatchObject({
      systemInstruction: "system text",
      responseMimeType: "application/json",
      temperature: 0,
    });
    expect(args.config.responseJsonSchema).toMatchObject({ type: "object", required: ["answer"] });
    expect(args.config.responseJsonSchema).not.toHaveProperty("$schema");
  });

  it("uses the quality model for quality requests", async () => {
    const { spy, provider: gemini } = provider(async () => ({ text: '{"answer":"x"}' }));
    await gemini.generateStructured({ ...request, role: "quality" });
    expect(spy.mock.calls[0]![0].model).toBe("quality-model");
  });

  it("shows the model the stricter schema when one is given", async () => {
    const { spy, provider: gemini } = provider(async () => ({ text: '{"answer":"x"}' }));
    await gemini.generateStructured({ ...request, modelSchema: z.object({ answer: z.string(), extra: z.number() }) });
    expect(spy.mock.calls[0]![0].config.responseJsonSchema).toMatchObject({ required: ["answer", "extra"] });
  });

  it("estimates usage when the API reports none", async () => {
    const { provider: gemini } = provider(async () => ({ text: '{"answer":"x"}' }));
    const response = await gemini.generateStructured(request);
    expect(response.usage.inputTokens).toBeGreaterThan(0);
    expect(response.usage.outputTokens).toBeGreaterThan(0);
  });

  it("falls back to describing the schema in the instructions when the schema is rejected", async () => {
    let calls = 0;
    const { spy, provider: gemini } = provider(async () => {
      calls++;
      if (calls === 1) throw apiError(400, "Invalid JSON schema");
      return { text: '{"answer":"ok"}' };
    });
    expect((await gemini.generateStructured(request)).data).toEqual({ answer: "ok" });
    const retry = spy.mock.calls[1]![0];
    expect(retry.config).not.toHaveProperty("responseJsonSchema");
    expect(String(retry.config.systemInstruction)).toContain("JSON Schema");

    // The provider remembers, so later requests do not waste a call.
    await gemini.generateStructured(request);
    expect(spy).toHaveBeenCalledTimes(3);
    expect(spy.mock.calls[2]![0].config).not.toHaveProperty("responseJsonSchema");
  });

  it("classifies a per-minute limit with its retry delay", async () => {
    const { provider: gemini } = provider(async () => {
      throw apiError(429, 'Quota exceeded for requests per minute. Please retry in 23.5s.');
    });
    const error = await gemini.generateStructured(request).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AIRateLimitError);
    expect(error).toMatchObject({ daily: false, retryAfterMs: 23_500 });
  });

  it("classifies a daily quota", async () => {
    const { provider: gemini } = provider(async () => {
      throw apiError(429, "Quota exceeded for metric generate_content_free_tier_requests, limit: 500 per day");
    });
    await expect(gemini.generateStructured(request)).rejects.toMatchObject({ daily: true });
  });

  it("treats server errors and network failures as unavailable", async () => {
    const down = provider(async () => {
      throw apiError(503, "overloaded");
    });
    await expect(down.provider.generateStructured(request)).rejects.toBeInstanceOf(AIUnavailableError);
    const offline = provider(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(offline.provider.generateStructured(request)).rejects.toBeInstanceOf(AIUnavailableError);
  });

  it.each([
    ["an empty response", ""],
    ["invalid JSON", "not json"],
    ["JSON that does not match the schema", '{"answer":42}'],
  ])("rejects %s", async (_label, text) => {
    const { provider: gemini } = provider(async () => ({ text }));
    await expect(gemini.generateStructured(request)).rejects.toBeInstanceOf(AIResponseError);
  });

  it("does not leak the API error message into its own errors", async () => {
    const { provider: gemini } = provider(async () => {
      throw apiError(403, "API key AIzaSECRET is invalid");
    });
    const error = (await gemini.generateStructured(request).catch((caught: unknown) => caught)) as Error;
    expect(error).toBeInstanceOf(AIResponseError);
    expect(error.message).not.toContain("AIzaSECRET");
  });
});

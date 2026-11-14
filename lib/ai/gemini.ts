import "server-only";

import { ApiError, GoogleGenAI } from "@google/genai";
import { z } from "zod";

import {
  AIRateLimitError,
  AIResponseError,
  AIUnavailableError,
  estimateTokens,
  type AIProvider,
  type StructuredRequest,
  type StructuredResponse,
} from "./provider";

/** The slice of the SDK this provider uses; lets tests substitute a double. */
export type GeminiClient = {
  models: {
    generateContent(args: {
      model: string;
      contents: string;
      config: Record<string, unknown>;
    }): Promise<{
      text?: string;
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
    }>;
  };
};

/** "retry in 23.5s", "retryDelay": "23s" */
function retryAfterMs(message: string): number | null {
  const match = /retry(?:Delay"?\s*:\s*"?| in )\s*([\d.]+)\s*s/i.exec(message);
  if (!match?.[1]) return null;
  const seconds = Number.parseFloat(match[1]);
  return Number.isFinite(seconds) ? Math.ceil(seconds * 1000) : null;
}

function isDailyQuota(message: string): boolean {
  return /per\s?day|perday|daily|requests_per_day|rpd/i.test(message);
}

export class GeminiProvider implements AIProvider {
  readonly name = "gemini";

  constructor(
    private readonly client: GeminiClient,
    private readonly models: { bulk: string; quality: string },
  ) {}

  static fromApiKey(apiKey: string, models: { bulk: string; quality: string }): GeminiProvider {
    return new GeminiProvider(new GoogleGenAI({ apiKey }) as unknown as GeminiClient, models);
  }

  /**
   * Whether the model accepts a response schema. If a request is rejected as
   * invalid, the schema is moved into the instructions instead and the
   * response is still validated here, so correctness does not depend on it.
   */
  private schemaInRequest = true;

  private async call(model: string, request: StructuredRequest<unknown>, withSchema: boolean) {
    const jsonSchema = z.toJSONSchema(request.modelSchema ?? request.schema) as Record<string, unknown>;
    delete jsonSchema.$schema;
    return this.client.models.generateContent({
      model,
      contents: request.prompt,
      config: {
        systemInstruction: withSchema
          ? request.system
          : `${request.system}\n\nReturn JSON matching this JSON Schema exactly:\n${JSON.stringify(jsonSchema)}`,
        responseMimeType: "application/json",
        ...(withSchema ? { responseJsonSchema: jsonSchema } : {}),
        temperature: 0,
        maxOutputTokens: request.maxOutputTokens ?? 4_096,
      },
    });
  }

  async generateStructured<T>(request: StructuredRequest<T>): Promise<StructuredResponse<T>> {
    const model = request.role === "quality" ? this.models.quality : this.models.bulk;

    let response: Awaited<ReturnType<GeminiClient["models"]["generateContent"]>>;
    try {
      try {
        response = await this.call(model, request, this.schemaInRequest);
      } catch (error) {
        if (!(this.schemaInRequest && error instanceof ApiError && error.status === 400)) throw error;
        this.schemaInRequest = false;
        response = await this.call(model, request, false);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = error instanceof ApiError ? error.status : undefined;
      if (status === 429) throw new AIRateLimitError(isDailyQuota(message), retryAfterMs(message));
      if (status !== undefined && status >= 500) throw new AIUnavailableError(`HTTP ${status}`);
      if (status !== undefined) throw new AIResponseError(`request rejected with HTTP ${status}`);
      throw new AIUnavailableError("network error");
    }

    const text = response.text;
    if (!text) throw new AIResponseError("empty response");

    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new AIResponseError("response was not valid JSON");
    }
    const parsed = request.schema.safeParse(json);
    if (!parsed.success) throw new AIResponseError("response did not match the schema");

    return {
      data: parsed.data,
      model,
      usage: {
        inputTokens:
          response.usageMetadata?.promptTokenCount ??
          estimateTokens(request.system + request.prompt),
        outputTokens: response.usageMetadata?.candidatesTokenCount ?? estimateTokens(text),
      },
    };
  }
}

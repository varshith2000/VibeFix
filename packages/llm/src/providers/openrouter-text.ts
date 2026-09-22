import type { z } from "zod";
import type { CompleteOptions, CompleteResult, TextGenerationClient } from "../capabilities/text-generation.js";
import { makeUsage } from "../usage.js";
import { LlmError } from "../errors.js";
import type { ProviderConfig } from "@vibefix/schemas";
import { postJson, extractFirstJson } from "./http.js";

interface OpenRouterTextResponse {
  choices?: Array<{ message?: { content?: string | null } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/**
 * OpenRouter chat-completions adapter for TextGeneration. Used as the live
 * fallback when a direct provider (Gemini) is unavailable — most users hold
 * an OpenRouter key even when they lack Anthropic/OpenAI ones.
 */
export class OpenRouterTextClient implements TextGenerationClient {
  readonly kind = "TextGeneration" as const;

  constructor(
    private readonly config: ProviderConfig,
    private readonly apiKey: string,
  ) {}

  get providerId(): string {
    return this.config.providerId;
  }
  get model(): string {
    return this.config.defaultModel;
  }

  async complete<T = unknown>(
    options: CompleteOptions & { responseSchema?: z.ZodType<T> },
  ): Promise<CompleteResult<T>> {
    const messages = [
      ...(options.system ? [{ role: "system" as const, content: options.system }] : []),
      ...options.messages,
    ];
    const res = await postJson<OpenRouterTextResponse>({
      url: `${this.config.baseUrl ?? "https://openrouter.ai"}/api/v1/chat/completions`,
      headers: { authorization: `Bearer ${this.apiKey}` },
      body: {
        model: this.model,
        max_tokens: options.maxTokens ?? this.config.maxOutputTokens,
        ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
        messages,
        ...(options.responseSchema ? { response_format: { type: "json_object" } } : {}),
      },
      signal: options.signal,
    });

    const text = res.choices?.[0]?.message?.content ?? "";
    if (!text) throw new LlmError("invalid-response", "empty completion", this.providerId);

    const result: CompleteResult<T> = {
      text,
      usage: makeUsage(res.usage?.prompt_tokens ?? 0, res.usage?.completion_tokens ?? 0),
      model: this.model,
      providerId: this.providerId,
    };
    if (options.responseSchema) {
      result.structured = options.responseSchema.parse(extractFirstJson(text));
    }
    return result;
  }
}

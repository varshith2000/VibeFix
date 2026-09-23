import type { z } from "zod";
import type { CompleteOptions, CompleteResult, TextGenerationClient } from "../capabilities/text-generation.js";
import { makeUsage } from "../usage.js";
import { LlmError } from "../errors.js";
import type { ProviderConfig } from "@vibefix/schemas";
import { postJson, extractFirstJson } from "./http.js";
import { zodHint } from "./zod-hint.js";

interface OpenAiResponse {
  choices: Array<{ message?: { content?: string | null } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export class OpenAiClient implements TextGenerationClient {
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
    // Check if this is a newer OpenAI model that uses max_completion_tokens
    const isNewerOpenAI = this.model.startsWith("gpt-4.1") || 
                         this.model.startsWith("gpt-4o") ||
                         this.model.startsWith("o1") ||
                         this.model.startsWith("o3");
    
    const body: Record<string, unknown> = {
      model: this.model,
      // Use max_completion_tokens for newer models, max_tokens for older ones
      ...(isNewerOpenAI 
        ? { max_completion_tokens: options.maxTokens ?? this.config.maxOutputTokens }
        : { max_tokens: options.maxTokens ?? this.config.maxOutputTokens }
      ),
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      messages: [
        ...(options.system ? [{ role: "system", content: options.system }] : []),
        ...options.messages.map((m) => ({ role: m.role, content: m.content })),
      ],
      ...(options.responseSchema ? { response_format: { type: "json_object" } } : {}),
    };
    
    const res = await postJson<OpenAiResponse>({
      url: `${this.config.baseUrl ?? "https://api.openai.com"}/v1/chat/completions`,
      headers: { authorization: `Bearer ${this.apiKey}` },
      body,
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

import type { z } from "zod";
import type { CompleteOptions, CompleteResult, TextGenerationClient } from "../capabilities/text-generation.js";
import { makeUsage } from "../usage.js";
import { LlmError } from "../errors.js";
import type { ProviderConfig } from "@vibefix/schemas";
import { postJson, extractFirstJson } from "./http.js";
import { zodHint } from "./zod-hint.js";

interface OllamaResponse {
  message?: { content?: string };
  prompt_eval_count?: number;
  eval_count?: number;
}

/** Local Ollama adapter — zero-cost, offline; structured via `format` JSON schema. */
export class OllamaClient implements TextGenerationClient {
  readonly kind = "TextGeneration" as const;

  constructor(private readonly config: ProviderConfig) {}

  get providerId(): string {
    return this.config.providerId;
  }
  get model(): string {
    return this.config.defaultModel;
  }

  async complete<T = unknown>(
    options: CompleteOptions & { responseSchema?: z.ZodType<T> },
  ): Promise<CompleteResult<T>> {
    const res = await postJson<OllamaResponse>({
      url: `${this.config.baseUrl ?? "http://localhost:11434"}/api/chat`,
      headers: {},
      body: {
        model: this.model,
        stream: false,
        ...(options.system ? { system: options.system } : {}),
        messages: options.messages.map((m) => ({ role: m.role, content: m.content })),
        ...(options.responseSchema ? { format: zodHint(options.responseSchema) } : {}),
        options: {
          num_predict: options.maxTokens ?? this.config.maxOutputTokens,
          ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
        },
      },
      timeoutMs: 300_000,
      signal: options.signal,
    });

    const text = res.message?.content ?? "";
    if (!text) throw new LlmError("invalid-response", "empty completion", this.providerId);

    const result: CompleteResult<T> = {
      text,
      usage: makeUsage(res.prompt_eval_count ?? 0, res.eval_count ?? 0),
      model: this.model,
      providerId: this.providerId,
    };
    if (options.responseSchema) {
      // Ollama's format hint is best-effort; still parse defensively.
      result.structured = options.responseSchema.parse(extractFirstJson(text));
    }
    return result;
  }
}

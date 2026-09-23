import type { z } from "zod";
import type {
  CompleteOptions,
  CompleteResult,
  TextGenerationClient,
} from "../capabilities/text-generation.js";
import { makeUsage } from "../usage.js";
import { LlmError } from "../errors.js";
import type { ProviderConfig } from "@vibefix/schemas";
import { postJson, extractFirstJson } from "./http.js";
import { zodHint } from "./zod-hint.js";

interface AnthropicResponse {
  content: Array<{ type: string; text?: string }>;
  usage: { input_tokens: number; output_tokens: number };
}

export class AnthropicClient implements TextGenerationClient {
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
    const system = this.buildSystem(options);
    
    // Check if this is a newer Claude model that doesn't support temperature
    const isNewerClaude = this.model.startsWith("claude-3.7") || 
                         this.model.startsWith("claude-3.5") ||
                         this.model.startsWith("claude-3-");
    
    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: options.maxTokens ?? this.config.maxOutputTokens,
      // Only include temperature for older models that support it
      ...(!isNewerClaude && options.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(system ? { system } : {}),
      messages: options.messages.map((m) => ({ role: m.role, content: m.content })),
    };
    
    const url = `${this.config.baseUrl ?? "https://api.anthropic.com"}/v1/messages`;
    const headers = {
      "x-api-key": this.apiKey,
      "anthropic-version": "2023-06-01",
    };
    
    let res: AnthropicResponse;
    try {
      res = await postJson<AnthropicResponse>({ url, headers, body, signal: options.signal });
    } catch (err) {
      // Newer Claude models reject `temperature` outright (HTTP 400
      // "`temperature` is deprecated for this model."). Drop it and retry
      // once rather than failing the whole agent call.
      if (
        body.temperature !== undefined &&
        err instanceof LlmError &&
        err.status === 400 &&
        /temperature/i.test(err.message)
      ) {
        delete body.temperature;
        res = await postJson<AnthropicResponse>({ url, headers, body, signal: options.signal });
      } else {
        throw err;
      }
    }

    const text = (res.content ?? [])
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("");
    if (!text) {
      throw new LlmError("invalid-response", "empty completion", this.providerId);
    }

    const result: CompleteResult<T> = {
      text,
      usage: makeUsage(res.usage?.input_tokens ?? 0, res.usage?.output_tokens ?? 0),
      model: this.model,
      providerId: this.providerId,
    };
    if (options.responseSchema) {
      const raw = extractFirstJson(text);
      result.structured = options.responseSchema.parse(raw);
    }
    return result;
  }

  private buildSystem(options: CompleteOptions): string {
    const parts: string[] = [];
    if (options.system) parts.push(options.system);
    if (options.responseSchema) {
      parts.push(
        "Your final reply must be a single JSON value matching this schema " +
          "(emit ONLY the JSON, no prose, no code fences):\n" +
          JSON.stringify(zodHint(options.responseSchema), null, 2),
      );
    }
    return parts.join("\n\n");
  }
}

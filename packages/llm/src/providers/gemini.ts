import type { z } from "zod";
import type { CompleteOptions, CompleteResult, TextGenerationClient } from "../capabilities/text-generation.js";
import { makeUsage } from "../usage.js";
import { LlmError } from "../errors.js";
import type { ProviderConfig } from "@vibefix/schemas";
import { postJson, extractFirstJson } from "./http.js";
import { geminiModelOverride, rememberGeminiModel, suggestedGeminiModel } from "./model-recovery.js";

interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

/**
 * Google Gemini adapter (Generative Language API, v1beta). Structured output
 * via responseMimeType json + defensive parse, same as the other adapters.
 * Note Gemini's role names: "user" / "model" (not assistant).
 */
export class GeminiClient implements TextGenerationClient {
  readonly kind = "TextGeneration" as const;

  constructor(
    private readonly config: ProviderConfig,
    private readonly apiKey: string,
  ) {}

  get providerId(): string {
    return this.config.providerId;
  }
  get model(): string {
    return geminiModelOverride(this.config.providerId) ?? this.config.defaultModel;
  }

  async complete<T = unknown>(
    options: CompleteOptions & { responseSchema?: z.ZodType<T> },
  ): Promise<CompleteResult<T>> {
    const system = options.system;
    const request = async (model: string): Promise<GeminiResponse> =>
      postJson<GeminiResponse>({
        url: `${this.config.baseUrl ?? "https://generativelanguage.googleapis.com"}/v1beta/models/${model}:generateContent`,
        headers: { "x-goog-api-key": this.apiKey },
        body: {
          contents: options.messages.map((m) => ({
            role: m.role === "assistant" ? "model" : "user",
            parts: [{ text: m.content }],
          })),
          ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
          generationConfig: {
            maxOutputTokens: options.maxTokens ?? this.config.maxOutputTokens,
            ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
            ...(options.responseSchema ? { responseMimeType: "application/json" } : {}),
          },
        },
        signal: options.signal,
      });

    let res: GeminiResponse;
    try {
      res = await request(this.model);
    } catch (err) {
      // Deprecated slug? Google's 404 names the replacement — adopt it for
      // the rest of the process instead of failing every call.
      const suggested = suggestedGeminiModel(err);
      if (suggested && suggested !== this.model) {
        rememberGeminiModel(this.config.providerId, suggested);
        res = await request(this.model);
      } else {
        throw err;
      }
    }

    const text = (res.candidates?.[0]?.content?.parts ?? [])
      .map((p) => p.text ?? "")
      .join("");
    if (!text) throw new LlmError("invalid-response", "empty completion", this.providerId);

    const result: CompleteResult<T> = {
      text,
      usage: makeUsage(
        res.usageMetadata?.promptTokenCount ?? 0,
        res.usageMetadata?.candidatesTokenCount ?? 0,
      ),
      model: this.model,
      providerId: this.providerId,
    };
    if (options.responseSchema) {
      result.structured = options.responseSchema.parse(extractFirstJson(text));
    }
    return result;
  }
}

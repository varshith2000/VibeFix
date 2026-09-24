import type { DecisionRequest, DecisionResult, TypedDecisionClient } from "../capabilities/typed-decision.js";
import { makeUsage } from "../usage.js";
import type { ProviderConfig } from "@vibefix/schemas";
import { postJson } from "./http.js";
import { buildDecisionPrompt, parseDecisionAnswers } from "./decision-wire.js";
import { geminiModelOverride, rememberGeminiModel, suggestedGeminiModel } from "./model-recovery.js";

interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

/**
 * TypedDecision straight against Google's Generative Language API — no
 * OpenRouter middleman. Decision traffic (risk scores, verdicts, rankings) is
 * small and frequent, so cutting the relay cuts latency and cost. JSON mode
 * via responseMimeType; parseDecisionAnswers enforces the typed contract.
 */
export class GeminiDecisionClient implements TypedDecisionClient {
  readonly kind = "TypedDecision" as const;

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

  async decide(request: DecisionRequest): Promise<DecisionResult> {
    const prompt = buildDecisionPrompt(request);
    const call = async (model: string): Promise<GeminiResponse> =>
      postJson<GeminiResponse>({
        url: `${this.config.baseUrl ?? "https://generativelanguage.googleapis.com"}/v1beta/models/${model}:generateContent`,
        headers: { "x-goog-api-key": this.apiKey },
        body: {
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: {
            maxOutputTokens: this.config.maxOutputTokens,
            temperature: 0,
            responseMimeType: "application/json",
          },
        },
        signal: request.signal,
      });

    let res: GeminiResponse;
    try {
      res = await call(this.model);
    } catch (err) {
      // Adopt Google's own replacement when the configured slug is deprecated.
      const suggested = suggestedGeminiModel(err);
      if (suggested && suggested !== this.model) {
        rememberGeminiModel(this.config.providerId, suggested);
        res = await call(this.model);
      } else {
        throw err;
      }
    }

    const text = (res.candidates?.[0]?.content?.parts ?? [])
      .map((p) => p.text ?? "")
      .join("");

    return {
      answers: parseDecisionAnswers(text, request, this.providerId),
      usage: makeUsage(
        res.usageMetadata?.promptTokenCount ?? 0,
        res.usageMetadata?.candidatesTokenCount ?? 0,
      ),
      model: this.model,
      providerId: this.providerId,
    };
  }
}

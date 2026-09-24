import type {
  DecisionRequest,
  DecisionResult,
  TypedDecisionClient,
} from "../capabilities/typed-decision.js";
import { makeUsage } from "../usage.js";
import { LlmError } from "../errors.js";
import type { ProviderConfig } from "@vibefix/schemas";
import { postJson } from "./http.js";
import { buildDecisionPrompt, parseDecisionAnswers } from "./decision-wire.js";
import { discoverFreeOpenRouterModel } from "./model-recovery.js";

interface OpenRouterResponse {
  choices: Array<{ message?: { content?: string | null } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/**
 * OpenRouter adapter implementing TypedDecision via JSON-schema-constrained
 * completions. Serves as the free/cheap fallback behind the direct Gemini
 * decision route, and as the pragmatic stand-in while Jev direct access is
 * waitlisted.
 */
export class OpenRouterDecisionClient implements TypedDecisionClient {
  readonly kind = "TypedDecision" as const;

  private readonly config: ProviderConfig;
  private readonly apiKey: string;
  /** Learned from the live catalog when the configured slug 404s. */
  private effectiveModel: string;

  constructor(config: ProviderConfig, apiKey: string) {
    this.config = config;
    this.apiKey = apiKey;
    this.effectiveModel = config.defaultModel;
  }

  get providerId(): string {
    return this.config.providerId;
  }
  get model(): string {
    return this.effectiveModel;
  }

  async decide(request: DecisionRequest): Promise<DecisionResult> {
    const schema = this.wireSchema(request.questions);
    const call = (model: string) =>
      postJson<OpenRouterResponse>({
        url: `${this.config.baseUrl ?? "https://openrouter.ai"}/api/v1/chat/completions`,
        headers: { authorization: `Bearer ${this.apiKey}` },
        body: {
          model,
          max_tokens: this.config.maxOutputTokens,
          temperature: 0,
          messages: [{ role: "user", content: buildDecisionPrompt(request) }],
          response_format: { type: "json_schema", json_schema: { name: "decisions", schema, strict: true } },
        },
        signal: request.signal,
      });

    let res: OpenRouterResponse;
    try {
      res = await call(this.effectiveModel);
    } catch (err) {
      // Free slugs retire without notice. NEVER adopt the paid slug the error
      // suggests — discover a model that is free RIGHT NOW and stick to it.
      if (err instanceof LlmError && err.status === 404) {
        const replacement = await discoverFreeOpenRouterModel(
          this.config.baseUrl,
          this.apiKey,
          new Set([this.effectiveModel]),
        );
        if (replacement) {
          this.effectiveModel = replacement;
          res = await call(this.effectiveModel);
        } else {
          throw err;
        }
      } else {
        throw err;
      }
    }

    const text = res.choices?.[0]?.message?.content ?? "";
    return {
      answers: parseDecisionAnswers(text, request, this.providerId),
      usage: makeUsage(res.usage?.prompt_tokens ?? 0, res.usage?.completion_tokens ?? 0),
      model: this.model,
      providerId: this.providerId,
    };
  }

  private wireSchema(questions: DecisionRequest["questions"]): unknown {
    const answerAnyOf = [
      {
        type: "object",
        properties: {
          questionIndex: { type: "integer" },
          kind: { type: "string", enum: ["choice"] },
          choice: { type: "string" },
        },
        required: ["questionIndex", "kind", "choice"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          questionIndex: { type: "integer" },
          kind: { type: "string", enum: ["score"] },
          scores: { type: "array", items: { type: "number" } },
        },
        required: ["questionIndex", "kind", "scores"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          questionIndex: { type: "integer" },
          kind: { type: "string", enum: ["noul"] },
          reason: { type: "string" },
        },
        required: ["questionIndex", "kind", "reason"],
        additionalProperties: false,
      },
    ];
    return {
      type: "object",
      properties: {
        answers: {
          type: "array",
          items: { anyOf: answerAnyOf },
          minItems: questions.length,
          maxItems: questions.length,
        },
      },
      required: ["answers"],
      additionalProperties: false,
    };
  }
}

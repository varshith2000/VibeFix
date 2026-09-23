import type {
  DecisionRequest,
  DecisionResult,
  TypedDecisionClient,
} from "../capabilities/typed-decision.js";
import { makeUsage } from "../usage.js";
import type { ProviderConfig } from "@vibefix/schemas";
import { postJson } from "./http.js";
import { buildDecisionPrompt, parseDecisionAnswers } from "./decision-wire.js";

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

  async decide(request: DecisionRequest): Promise<DecisionResult> {
    const schema = this.wireSchema(request.questions);
    const res = await postJson<OpenRouterResponse>({
      url: `${this.config.baseUrl ?? "https://openrouter.ai"}/api/v1/chat/completions`,
      headers: { authorization: `Bearer ${this.apiKey}` },
      body: {
        model: this.model,
        max_tokens: this.config.maxOutputTokens,
        temperature: 0,
        messages: [{ role: "user", content: buildDecisionPrompt(request) }],
        response_format: { type: "json_schema", json_schema: { name: "decisions", schema, strict: true } },
      },
      signal: request.signal,
    });

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

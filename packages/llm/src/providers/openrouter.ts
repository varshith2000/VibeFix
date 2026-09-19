import type {
  DecisionRequest,
  DecisionResult,
  DecisionAnswer,
  TypedDecisionClient,
} from "../capabilities/typed-decision.js";
import { makeUsage } from "../usage.js";
import { LlmError } from "../errors.js";
import type { ProviderConfig } from "@vibefix/schemas";
import { postJson, extractFirstJson } from "./http.js";

interface OpenRouterResponse {
  choices: Array<{ message?: { content?: string | null } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

interface DecisionWireAnswer {
  questionIndex: number;
  kind: "choice" | "score" | "noul";
  choice?: string;
  scores?: number[];
  rationale?: string;
  reason?: string;
}

/**
 * OpenRouter adapter implementing TypedDecision via JSON-schema-constrained
 * completions. Pragmatic fallback while Jev direct access is waitlisted.
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
    const prompt =
      "You are a calibrated decision engine. Answer EVERY question with a typed answer.\n" +
      "Return ONLY a JSON object: {\"answers\": [...]} where each answer is " +
      '{"questionIndex":n,"kind":"choice","choice":"..."} or ' +
      '{"questionIndex":n,"kind":"score","scores":[...]} or ' +
      '{"questionIndex":n,"kind":"noul","reason":"..."} if the evidence cannot support a decision.\n\n' +
      "EVIDENCE:\n" +
      request.context +
      "\n\nQUESTIONS:\n" +
      request.questions
        .map((q, i) => {
          if (q.type === "choice") {
            return `${i}. [choice] ${q.question} Options: ${q.choices.join(" | ")}` +
              (q.rubric ? ` Rubric: ${q.rubric}` : "");
          }
          return `${i}. [score ${q.scale.min}-${q.scale.max}] ${q.question} Items: ${q.items.join(" | ")} Rubric: ${q.rubric}`;
        })
        .join("\n");

    const res = await postJson<OpenRouterResponse>({
      url: `${this.config.baseUrl ?? "https://openrouter.ai"}/api/v1/chat/completions`,
      headers: { authorization: `Bearer ${this.apiKey}` },
      body: {
        model: this.model,
        max_tokens: this.config.maxOutputTokens,
        temperature: 0,
        messages: [{ role: "user", content: prompt }],
        response_format: { type: "json_schema", json_schema: { name: "decisions", schema, strict: true } },
      },
      signal: request.signal,
    });

    const text = res.choices?.[0]?.message?.content ?? "";
    if (!text) throw new LlmError("invalid-response", "empty completion", this.providerId);
    const parsed = extractFirstJson(text) as { answers?: DecisionWireAnswer[] };
    const wireAnswers = parsed.answers;
    if (!Array.isArray(wireAnswers)) {
      throw new LlmError("invalid-response", "missing answers array", this.providerId);
    }

    const answers: DecisionAnswer[] = [];
    for (const a of wireAnswers) {
      const q = request.questions[a.questionIndex];
      if (!q) continue;
      if (a.kind === "noul") {
        answers.push({ questionIndex: a.questionIndex, kind: "noul", reason: a.reason ?? "no calibrated answer" });
      } else if (q.type === "choice") {
        if (!a.choice) throw new LlmError("invalid-response", "choice answer missing choice", this.providerId);
        answers.push({ questionIndex: a.questionIndex, kind: "choice", choice: a.choice });
      } else {
        if (!Array.isArray(a.scores) || a.scores.length !== q.items.length) {
          throw new LlmError("invalid-response", "score answer mismatch", this.providerId);
        }
        answers.push({ questionIndex: a.questionIndex, kind: "score", scores: a.scores });
      }
    }
    if (answers.length !== request.questions.length) {
      throw new LlmError(
        "invalid-response",
        `expected ${request.questions.length} answers, got ${answers.length}`,
        this.providerId,
      );
    }

    return {
      answers,
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

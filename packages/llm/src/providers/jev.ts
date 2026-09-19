import type {
  DecisionRequest,
  DecisionResult,
  DecisionAnswer,
  TypedDecisionClient,
} from "../capabilities/typed-decision.js";
import { makeUsage } from "../usage.js";
import { LlmError } from "../errors.js";
import type { ProviderConfig } from "@vibefix/schemas";
import { postJson } from "./http.js";

/**
 * Jev (TypeSafe AI) adapter — the native TypedDecision provider.
 *
 * Wire contract (documented seam — enable once keys ship from the waitlist):
 *   POST {baseUrl}/v1/decisions
 *   Authorization: Bearer <key>
 *   {
 *     "model": "jev-latest",
 *     "context": "<evidence text>",
 *     "questions": [
 *       { "type": "choice", "question": "...", "choices": ["a","b"], "allowNoul": true },
 *       { "type": "score",  "question": "...", "items": ["x","y"], "scale": {"min":0,"max":100} }
 *     ]
 *   }
 * Response:
 *   { "answers": [ {"kind":"choice","choice":"a","confidence":0.82,"rationale":"..."}
 *                | {"kind":"score","scores":[12,88]}
 *                | {"kind":"noul","reason":"..."} ],
 *     "usage": {"inputTokens":n,"outputTokens":n} }
 */
interface JevWireAnswer {
  kind?: string;
  choice?: string;
  scores?: number[];
  confidence?: number;
  rationale?: string;
  reason?: string;
}

interface JevWireResponse {
  answers?: JevWireAnswer[];
  usage?: { inputTokens?: number; outputTokens?: number };
}

export class JevClient implements TypedDecisionClient {
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
    const res = await postJson<JevWireResponse>({
      url: `${this.config.baseUrl ?? "https://api.typesafe.ai"}/v1/decisions`,
      headers: { authorization: `Bearer ${this.apiKey}` },
      body: {
        model: this.model,
        context: request.context,
        questions: request.questions.map((q) =>
          q.type === "choice"
            ? {
                type: "choice",
                question: q.question,
                choices: q.choices,
                ...(q.rubric ? { rubric: q.rubric } : {}),
                allowNoul: q.allowNoul ?? true,
              }
            : {
                type: "score",
                question: q.question,
                items: q.items,
                scale: q.scale,
                rubric: q.rubric,
              },
        ),
      },
      signal: request.signal,
    });

    const answers: DecisionAnswer[] = (res.answers ?? []).map((a, i) => {
      const q = request.questions[i];
      if (!q) throw new LlmError("invalid-response", `extra answer at index ${i}`, this.providerId);
      if (a.kind === "noul" || a.choice === undefined) {
        return { questionIndex: i, kind: "noul", reason: a.reason ?? "no calibrated answer" };
      }
      if (q.type === "choice") {
        return {
          questionIndex: i,
          kind: "choice",
          choice: a.choice,
          ...(a.confidence !== undefined ? { confidence: a.confidence } : {}),
          ...(a.rationale ? { rationale: a.rationale } : {}),
        };
      }
      if (!Array.isArray(a.scores) || a.scores.length !== q.items.length) {
        throw new LlmError(
          "invalid-response",
          `score answer length mismatch at index ${i}`,
          this.providerId,
        );
      }
      return {
        questionIndex: i,
        kind: "score",
        scores: a.scores,
        ...(a.confidence !== undefined ? { confidence: a.confidence } : {}),
        ...(a.rationale ? { rationale: a.rationale } : {}),
      };
    });

    if (answers.length !== request.questions.length) {
      throw new LlmError(
        "invalid-response",
        `expected ${request.questions.length} answers, got ${answers.length}`,
        this.providerId,
      );
    }

    return {
      answers,
      usage: makeUsage(res.usage?.inputTokens ?? 0, res.usage?.outputTokens ?? 0),
      model: this.model,
      providerId: this.providerId,
    };
  }
}

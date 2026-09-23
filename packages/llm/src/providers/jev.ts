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
 * Real wire contract (docs.typesafe.ai):
 *   POST {baseUrl}/v1/systemone
 *   Authorization: Bearer <key>
 *   {
 *     "model": "jev-latest",
 *     "state": "<evidence text>",
 *     "questions": {
 *       "<id>": { "type": "choice", "instructions": "...",
 *                 "criteria": { "label": "description", ... } },
 *       "<id>": { "type": "score", "instructions": "...",
 *                 "criteria": ["level 0 desc", "level 1 desc", ...] }
 *     }
 *   }
 * Response:
 *   { "model": "jev-1.x.y",
 *     "answers": { "<id>": { "type": "choice", "choice": "label",
 *                            "confidence": 0.78, "probabilities": {...} }
 *                          | { "type": "score", "score": 1.0, "confidence": 1.0,
 *                              "legend": {...}, "probabilities": {...} }
 *                          | { "type": "noul", "noul": 1.0 } },
 *     "usage": { "input_tokens": n, "output_tokens": n } }
 *
 * Jev's score answers are an INDEX into the criteria levels, so numeric scales
 * (e.g. 0–100 risk) are encoded as discrete levels and decoded back to values.
 * One internal score question over N items becomes N Jev questions
 * (`q<i>_i<j>`), one per item.
 */
interface JevWireAnswer {
  type?: string;
  choice?: string;
  score?: number;
  confidence?: number;
}

interface JevWireResponse {
  answers?: Record<string, JevWireAnswer>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

/** Discrete level values for a numeric scale (≤11 levels keeps answers cheap). */
function scaleLevels(scale: { min: number; max: number }): number[] {
  const span = scale.max - scale.min;
  if (span <= 10) {
    return Array.from({ length: span + 1 }, (_, i) => scale.min + i);
  }
  return Array.from({ length: 11 }, (_, i) =>
    Math.round(scale.min + (span * i) / 10),
  );
}

interface WireQuestion {
  type: "choice" | "score";
  instructions: string;
  criteria: Record<string, string> | string[];
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
    const questions: Record<string, WireQuestion> = {};
    // Per-question decode info: which levels map back to numeric values.
    const scoreLevels: Array<number[] | null> = [];

    request.questions.forEach((q, qi) => {
      if (q.type === "choice") {
        questions[`q${qi}`] = {
          type: "choice",
          instructions:
            q.question + (q.rubric ? `\nRubric: ${q.rubric}` : ""),
          criteria: Object.fromEntries(q.choices.map((c) => [c, c])),
        };
        scoreLevels.push(null);
        return;
      }
      const levels = scaleLevels(q.scale);
      q.items.forEach((item, ii) => {
        questions[`q${qi}_i${ii}`] = {
          type: "score",
          instructions:
            `${q.question}\nItem: ${item}\nRubric: ${q.rubric}\n` +
            `Pick the level (0–${levels.length - 1}) that matches this item.`,
          criteria: levels.map((v) => `${v}`),
        };
      });
      scoreLevels.push(levels);
    });

    let res: JevWireResponse;
    try {
      res = await postJson<JevWireResponse>({
        url: `${this.config.baseUrl ?? "https://api.typesafe.ai"}/v1/systemone`,
        headers: { authorization: `Bearer ${this.apiKey}` },
        body: {
          model: this.model,
          state: request.context,
          questions,
        },
        signal: request.signal,
      });
    } catch (err) {
      // Enhanced error handling for Jev API failures
      if (err instanceof LlmError) {
        console.error(`[Jev] API error for model ${this.model}:`, err.message);
        // Return NOUL answers for all questions if the API fails
        return {
          answers: request.questions.map((q, qi) => ({
            questionIndex: qi,
            kind: "noul",
            reason: `Jev API error: ${err.message}`,
          })),
          usage: makeUsage(0, 0),
          model: this.model,
          providerId: this.providerId,
        };
      }
      throw err;
    }

    const answers: DecisionAnswer[] = request.questions.map((q, qi) => {
      if (q.type === "choice") {
        const a = res.answers?.[`q${qi}`];
        if (a?.type === "choice" && a.choice !== undefined && q.choices.includes(a.choice)) {
          return {
            questionIndex: qi,
            kind: "choice",
            choice: a.choice,
            ...(a.confidence !== undefined ? { confidence: a.confidence } : {}),
          };
        }
        return {
          questionIndex: qi,
          kind: "noul",
          reason: a ? `unexpected answer shape (${a.type ?? "none"})` : "no answer returned",
        };
      }
      // score: decode every item's level index back to a numeric value
      const levels = scoreLevels[qi]!;
      const scores: number[] = [];
      let confidence: number | undefined;
      for (let ii = 0; ii < q.items.length; ii++) {
        const a = res.answers?.[`q${qi}_i${ii}`];
        if (a?.type !== "score" || typeof a.score !== "number") {
          return {
            questionIndex: qi,
            kind: "noul",
            reason: `incomplete score answer for item ${ii} (${q.items[ii]})`,
          } satisfies DecisionAnswer;
        }
        const idx = Math.max(0, Math.min(levels.length - 1, Math.round(a.score)));
        scores.push(levels[idx]!);
        if (a.confidence !== undefined) confidence = a.confidence;
      }
      return {
        questionIndex: qi,
        kind: "score",
        scores,
        ...(confidence !== undefined ? { confidence } : {}),
      };
    });

    return {
      answers,
      usage: makeUsage(res.usage?.input_tokens ?? 0, res.usage?.output_tokens ?? 0),
      model: this.model,
      providerId: this.providerId,
    };
  }
}

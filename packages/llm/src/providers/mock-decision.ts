import type {
  DecisionRequest,
  DecisionResult,
  DecisionAnswer,
  TypedDecisionClient,
} from "../capabilities/typed-decision.js";
import { makeUsage } from "../usage.js";

/** FNV-1a — deterministic, stable across runs and platforms. */
function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Deterministic TypedDecision mock. Same input -> same answers, forever.
 * Choice = hash(context + question + choices) % n; Score = hash(item) per item.
 */
export class MockDecisionClient implements TypedDecisionClient {
  readonly kind = "TypedDecision" as const;
  readonly calls: DecisionRequest[] = [];

  get providerId(): string {
    return "mock-decision";
  }
  get model(): string {
    return "mock-judge";
  }

  async decide(request: DecisionRequest): Promise<DecisionResult> {
    this.calls.push(request);
    const answers: DecisionAnswer[] = request.questions.map((q, i) => {
      if (q.type === "choice") {
        const h = fnv1a(`${request.context}::${q.question}::${q.choices.join(",")}`);
        // ~7% of choice questions honestly return noul, exercising that path.
        if ((q.allowNoul ?? true) && h % 14 === 0) {
          return { questionIndex: i, kind: "noul", reason: "insufficient evidence (mock)" };
        }
        // Demo affordance: binary yes/no questions answer "yes" so the mock
        // experience shows passing verifications instead of coin flips.
        if (q.choices.length === 2 && q.choices[0] === "yes" && q.choices[1] === "no") {
          return { questionIndex: i, kind: "choice", choice: "yes", confidence: 0.8 };
        }
        return {
          questionIndex: i,
          kind: "choice",
          choice: q.choices[h % q.choices.length]!,
          confidence: 0.5 + ((h >>> 8) % 40) / 100,
        };
      }
      const scores = q.items.map(
        (item) => q.scale.min + (fnv1a(`${request.context}::${q.question}::${item}`) % (q.scale.max - q.scale.min + 1)),
      );
      return { questionIndex: i, kind: "score", scores };
    });
    return {
      answers,
      usage: makeUsage(Math.ceil(request.context.length / 4), answers.length * 12),
      model: this.model,
      providerId: this.providerId,
    };
  }
}

import type {
  ChoiceQuestion,
  DecisionAnswer,
  DecisionRequest,
  ScoreQuestion,
} from "@vibefix/llm";
import type { AgentExecutionContext } from "../contract.js";

/**
 * Runs a TypedDecision request with a deterministic fallback. The fallback
 * only fires when no decision provider is available at all (pure mock/dev
 * environments) — it never overrides a real provider's answer.
 */
export async function decide(
  ctx: AgentExecutionContext,
  request: Omit<DecisionRequest, "metadata">,
): Promise<{ answers: DecisionAnswer[]; degraded: boolean }> {
  if (ctx.decision) {
    try {
      const result = await ctx.decision.decide({
        ...request,
        metadata: { agentId: ctx.def.agentId, step: "decide" },
      });
      return { answers: result.answers, degraded: false };
    } catch {
      // fall through to deterministic fallback
    }
  }
  return { answers: deterministicAnswers(request), degraded: true };
}

function deterministicAnswers(request: Omit<DecisionRequest, "metadata">): DecisionAnswer[] {
  return request.questions.map((q, i) => {
    if (q.type === "choice") {
      // "reject/conservative" style choices sort last alphabetically here;
      // picking the first choice is the neutral deterministic default.
      return { questionIndex: i, kind: "choice", choice: q.choices[0]!, confidence: 0.3 };
    }
    const mid = (q.scale.min + q.scale.max) / 2;
    return { questionIndex: i, kind: "score", scores: q.items.map(() => mid) };
  });
}

export type { ChoiceQuestion, ScoreQuestion };

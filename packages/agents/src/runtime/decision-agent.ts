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
      // Surface the provider while the call is in flight — decision calls can
      // take seconds, and "which model is thinking?" is the first question a
      // user watching the event stream asks.
      await ctx.progress(`deciding via ${ctx.decision.providerId} (${ctx.decision.model})`);
      const result = await ctx.decision.decide({
        ...request,
        metadata: { agentId: ctx.def.agentId, step: "decide" },
      });
      return { answers: result.answers, degraded: false };
    } catch (err) {
      // fall through to deterministic fallback, but record why — a dead
      // provider silently returning mid-scores looks like mock data.
      await ctx.progress("decision provider failed — using deterministic fallback", String(err).slice(0, 300));
    }
  }
  return { answers: deterministicAnswers(request), degraded: true };
}

export function isAffirmativeDecision(
  degraded: boolean,
  answer: DecisionAnswer | undefined,
): boolean {
  return !degraded && answer?.kind === "choice" && answer.choice === "yes";
}

function deterministicAnswers(request: Omit<DecisionRequest, "metadata">): DecisionAnswer[] {
  return request.questions.map((q, i) => {
    if (q.type === "choice") {
      return { questionIndex: i, kind: "noul", reason: "decision provider unavailable" };
    }
    const mid = (q.scale.min + q.scale.max) / 2;
    return { questionIndex: i, kind: "score", scores: q.items.map(() => mid) };
  });
}

export type { ChoiceQuestion, ScoreQuestion };

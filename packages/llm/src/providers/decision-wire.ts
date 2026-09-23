import type { DecisionAnswer, DecisionRequest } from "../capabilities/typed-decision.js";
import { LlmError } from "../errors.js";
import { extractFirstJson } from "./http.js";

export interface DecisionWireAnswer {
  questionIndex: number;
  kind: "choice" | "score" | "noul";
  choice?: string;
  scores?: number[];
  rationale?: string;
  reason?: string;
}

/**
 * Wire protocol shared by every TypedDecision adapter (Gemini direct,
 * OpenRouter, Jev when it ships): one prompt, one JSON answers array. Keeping
 * the prompt/parse in one place means a calibration fix lands everywhere.
 */
export function buildDecisionPrompt(request: DecisionRequest): string {
  return (
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
      .join("\n")
  );
}

/** Parse + validate model text into typed answers. Throws LlmError on drift. */
export function parseDecisionAnswers(
  text: string,
  request: DecisionRequest,
  providerId: string,
): DecisionAnswer[] {
  if (!text) throw new LlmError("invalid-response", "empty completion", providerId);
  const parsed = extractFirstJson(text) as { answers?: DecisionWireAnswer[] };
  const wireAnswers = parsed.answers;
  if (!Array.isArray(wireAnswers)) {
    throw new LlmError("invalid-response", "missing answers array", providerId);
  }

  const answers: DecisionAnswer[] = [];
  for (const a of wireAnswers) {
    const q = request.questions[a.questionIndex];
    if (!q) continue;
    if (a.kind === "noul") {
      answers.push({ questionIndex: a.questionIndex, kind: "noul", reason: a.reason ?? "no calibrated answer" });
    } else if (q.type === "choice") {
      if (!a.choice) throw new LlmError("invalid-response", "choice answer missing choice", providerId);
      answers.push({ questionIndex: a.questionIndex, kind: "choice", choice: a.choice });
    } else {
      if (!Array.isArray(a.scores) || a.scores.length !== q.items.length) {
        throw new LlmError("invalid-response", "score answer mismatch", providerId);
      }
      answers.push({ questionIndex: a.questionIndex, kind: "score", scores: a.scores });
    }
  }
  if (answers.length !== request.questions.length) {
    throw new LlmError(
      "invalid-response",
      `expected ${request.questions.length} answers, got ${answers.length}`,
      providerId,
    );
  }
  return answers;
}

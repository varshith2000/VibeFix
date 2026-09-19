import type { TokenUsage } from "../usage.js";

/**
 * A question with a typed answer contract. There are exactly three answer
 * kinds, mirroring Jev's model:
 * - choice: pick one of N options (or "noul" = cannot answer calibrated)
 * - score:  score each item on a numeric scale
 * - noul:   the honest "I cannot decide from this evidence" answer
 */
export interface ChoiceQuestion {
  type: "choice";
  question: string;
  choices: string[];
  /** What a good answer optimizes for. The decision rubric is part of the contract. */
  rubric?: string;
  /** Allow the model to return noul instead of forcing a choice. Default true. */
  allowNoul?: boolean;
}

export interface ScoreQuestion {
  type: "score";
  question: string;
  items: string[];
  scale: { min: number; max: number };
  rubric: string;
}

export type DecisionQuestion = ChoiceQuestion | ScoreQuestion;

export type DecisionAnswer =
  | { questionIndex: number; kind: "choice"; choice: string; confidence?: number; rationale?: string }
  | { questionIndex: number; kind: "score"; scores: number[]; confidence?: number; rationale?: string }
  | { questionIndex: number; kind: "noul"; reason: string };

export interface DecisionRequest {
  /** The evidence bundle the decision is made over. Plain text, budgeted by caller. */
  context: string;
  questions: DecisionQuestion[];
  signal?: AbortSignal;
  metadata?: { agentId?: string; step?: string };
}

export interface DecisionResult {
  answers: DecisionAnswer[];
  usage: TokenUsage;
  model: string;
  providerId: string;
}

/**
 * Capability: typed decision evaluation. Decision-heavy agents (risk scoring,
 * backlog ranking, verdicts, gates) use this instead of prose generation —
 * no completion loop, calibrated structured answers, cheap by construction.
 */
export interface TypedDecisionClient {
  readonly kind: "TypedDecision";
  readonly providerId: string;
  readonly model: string;
  decide(request: DecisionRequest): Promise<DecisionResult>;
}

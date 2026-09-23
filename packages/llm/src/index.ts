export type {
  TextMessage,
  CompleteOptions,
  CompleteResult,
  TextGenerationClient,
} from "./capabilities/text-generation.js";
export type {
  ChoiceQuestion,
  ScoreQuestion,
  DecisionQuestion,
  DecisionAnswer,
  DecisionRequest,
  DecisionResult,
  TypedDecisionClient,
} from "./capabilities/typed-decision.js";
export type { TokenUsage } from "./usage.js";
export { makeUsage } from "./usage.js";
export { LlmError, httpErrorKind, type LlmErrorKind } from "./errors.js";
export { LlmRouter, type UsageSink, type MockHandles } from "./router.js";
export { MockTextClient } from "./providers/mock-text.js";
export { MockDecisionClient } from "./providers/mock-decision.js";
export { extractFirstJson } from "./providers/http.js";
export { OpenRouterTextClient } from "./providers/openrouter-text.js";
export { GeminiDecisionClient } from "./providers/gemini-decision.js";
export { zodHint } from "./providers/zod-hint.js";

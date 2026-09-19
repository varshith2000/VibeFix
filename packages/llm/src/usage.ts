/** Token accounting shared by all providers. The budget meter aggregates these. */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  /** Total tokens if the provider reports it; else input+output. */
  totalTokens: number;
}

export function makeUsage(input: number, output: number): TokenUsage {
  return { inputTokens: input, outputTokens: output, totalTokens: input + output };
}

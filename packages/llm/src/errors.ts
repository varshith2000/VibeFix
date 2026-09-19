/** Provider failure taxonomy. Drives router fallback + budget accounting. */
export type LlmErrorKind =
  | "auth"
  | "rate-limit"
  | "network"
  | "invalid-response"
  | "budget"
  | "disabled"
  | "unknown";

export class LlmError extends Error {
  constructor(
    public readonly kind: LlmErrorKind,
    message: string,
    public readonly providerId: string,
    public readonly status?: number,
    public override readonly cause?: unknown,
  ) {
    super(`[${providerId}] ${message}`);
    this.name = "LlmError";
  }

  /** Should the router try the fallback provider? */
  get retryable(): boolean {
    return this.kind === "rate-limit" || this.kind === "network" || this.kind === "unknown";
  }
}

export function httpErrorKind(status: number): LlmErrorKind {
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate-limit";
  if (status >= 500) return "network";
  return "invalid-response";
}

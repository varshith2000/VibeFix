import type { z } from "zod";
import type { TokenUsage } from "../usage.js";

export interface TextMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface CompleteOptions {
  system?: string;
  messages: TextMessage[];
  maxTokens?: number;
  temperature?: number;
  /**
   * Structured output contract. Providers that support JSON-mode enforce it
   * natively; others get a repair-parse-validate loop in the client wrapper.
   */
  responseSchema?: z.ZodType;
  signal?: AbortSignal;
  /** Telemetry only — never affects provider behavior except in mocks/tests. */
  metadata?: { agentId?: string; step?: string };
}

export interface CompleteResult<T = unknown> {
  text: string;
  /** Present when responseSchema was requested and parsing succeeded. */
  structured?: T;
  usage: TokenUsage;
  model: string;
  providerId: string;
}

/**
 * Capability: free-form text generation. The ONLY interface generative agents
 * ever see — no provider SDKs leak past this boundary.
 */
export interface TextGenerationClient {
  readonly kind: "TextGeneration";
  readonly providerId: string;
  readonly model: string;
  complete<T = unknown>(options: CompleteOptions & { responseSchema?: z.ZodType<T> }): Promise<CompleteResult<T>>;
}

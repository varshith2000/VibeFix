import type { z } from "zod";
import type { CompleteOptions, CompleteResult, TextGenerationClient } from "../capabilities/text-generation.js";
import { makeUsage } from "../usage.js";
import { LlmError } from "../errors.js";

/**
 * Deterministic mock for tests and the M1 vertical slice. Scripts are keyed by
 * agentId (options.metadata.agentId). A script value may be a string (plain
 * text) or an object (used as the structured output). Zero network, zero cost.
 */
export class MockTextClient implements TextGenerationClient {
  readonly kind = "TextGeneration" as const;
  private readonly scripts = new Map<string, unknown>();
  private fallback: unknown = null;
  readonly calls: Array<{ agentId?: string; system?: string; lastUserMessage: string }> = [];

  get providerId(): string {
    return "mock-text";
  }
  get model(): string {
    return "mock-coder";
  }

  /** Register the canned response for an agent. */
  when(agentId: string, payload: unknown): this {
    this.scripts.set(agentId, payload);
    return this;
  }

  /** Response for agents without a registered script. */
  default(payload: unknown): this {
    this.fallback = payload;
    return this;
  }

  /** True when this agent has a usable canned response. */
  has(agentId: string): boolean {
    return this.scripts.has(agentId) || this.fallback !== null;
  }

  async complete<T = unknown>(
    options: CompleteOptions & { responseSchema?: z.ZodType<T> },
  ): Promise<CompleteResult<T>> {
    const agentId = options.metadata?.agentId;
    this.calls.push({
      agentId,
      system: options.system?.slice(0, 200),
      lastUserMessage: options.messages.at(-1)?.content.slice(0, 500) ?? "",
    });
    const script = (agentId !== undefined && this.scripts.get(agentId)) ?? this.fallback;
    if (script === null || script === undefined) {
      throw new LlmError(
        "invalid-response",
        `no mock script registered${agentId ? ` for agent '${agentId}'` : ""}`,
        this.providerId,
      );
    }
    const text = typeof script === "string" ? script : JSON.stringify(script, null, 2);
    const result: CompleteResult<T> = {
      text,
      usage: makeUsage(
        Math.ceil((options.system?.length ?? 0 + text.length) / 4),
        Math.ceil(text.length / 4),
      ),
      model: this.model,
      providerId: this.providerId,
    };
    if (options.responseSchema) {
      result.structured = options.responseSchema.parse(
        typeof script === "string" ? JSON.parse(script) : script,
      );
    }
    return result;
  }
}

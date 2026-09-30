import type { z } from "zod";
import type { ProviderConfig, ModelRouting } from "@vibefix/schemas";
import type {
  CompleteOptions,
  CompleteResult,
  TextGenerationClient,
} from "./capabilities/text-generation.js";
import type {
  DecisionRequest,
  DecisionResult,
  TypedDecisionClient,
} from "./capabilities/typed-decision.js";
import type { TokenUsage } from "./usage.js";
import { LlmError } from "./errors.js";
import { AnthropicClient } from "./providers/anthropic.js";
import { OpenAiClient } from "./providers/openai.js";
import { GeminiClient } from "./providers/gemini.js";
import { GeminiDecisionClient } from "./providers/gemini-decision.js";
import { OllamaClient } from "./providers/ollama.js";
import { JevClient } from "./providers/jev.js";
import { OpenRouterDecisionClient } from "./providers/openrouter.js";
import { OpenRouterTextClient } from "./providers/openrouter-text.js";
import { MockTextClient } from "./providers/mock-text.js";
import { MockDecisionClient } from "./providers/mock-decision.js";
import { redactSecrets } from "@vibefix/schemas";

export type UsageSink = (agentId: string, providerId: string, usage: TokenUsage) => void;

/** Shared mock instances so tests can register scripts / inspect calls. */
export interface MockHandles {
  mockText: MockTextClient;
  mockDecision: MockDecisionClient;
}

function buildProvider(
  config: ProviderConfig,
  env: Record<string, string | undefined>,
  mocks: MockHandles,
): TextGenerationClient | TypedDecisionClient | null {
  if (!config.enabled) return null;
  const key = config.apiKeyEnv ? env[config.apiKeyEnv] : undefined;
  if (config.apiKeyEnv && !key) return null; // configured but no key -> unavailable
  switch (config.adapter) {
    case "anthropic":
      return new AnthropicClient(config, key ?? "");
    case "openai":
      return new OpenAiClient(config, key ?? "");
    case "gemini":
      return new GeminiClient(config, key ?? "");
    case "gemini-decision":
      return new GeminiDecisionClient(config, key ?? "");
    case "ollama":
      return new OllamaClient(config);
    case "jev":
      return new JevClient(config, key ?? "");
    case "openrouter":
      return new OpenRouterDecisionClient(config, key ?? "");
    case "openrouter-text":
      return new OpenRouterTextClient(config, key ?? "");
    case "mock-text":
      return mocks.mockText; // persistent instance: scripts + call counting survive rebuilds
    case "mock-decision":
      return mocks.mockDecision;
  }
}

class MeteredText implements TextGenerationClient {
  readonly kind = "TextGeneration" as const;
  constructor(
    private readonly inner: TextGenerationClient,
    private readonly agentId: string,
    private readonly sink: UsageSink | undefined,
  ) {}
  get providerId(): string {
    return this.inner.providerId;
  }
  get model(): string {
    return this.inner.model;
  }
  async complete<T = unknown>(
    options: CompleteOptions & { responseSchema?: z.ZodType<T> },
  ): Promise<CompleteResult<T>> {
    const result = await this.inner.complete({
      ...options,
      system: options.system ? redactSecrets(options.system) : options.system,
      messages: options.messages.map((message) => ({
        ...message,
        content: redactSecrets(message.content),
      })),
    });
    this.sink?.(this.agentId, result.providerId, result.usage);
    return result;
  }
}

class MeteredDecision implements TypedDecisionClient {
  readonly kind = "TypedDecision" as const;
  constructor(
    private readonly inner: TypedDecisionClient,
    private readonly agentId: string,
    private readonly sink: UsageSink | undefined,
  ) {}
  get providerId(): string {
    return this.inner.providerId;
  }
  get model(): string {
    return this.inner.model;
  }
  async decide(request: DecisionRequest): Promise<DecisionResult> {
    const result = await this.inner.decide({ ...request, context: redactSecrets(request.context) });
    this.sink?.(this.agentId, result.providerId, result.usage);
    return result;
  }
}

/** Hard failures that mean "this provider is gone" — stop offering it. */
function isProviderDead(err: unknown): boolean {
  return err instanceof LlmError && (err.kind === "auth" || err.status === 404);
}

/** Primary with fallback: any provider failure transparently chains.
 *
 * A DEAD provider (auth/404 — deprecated model slug, rotated key) must fall
 * through to the next hop, not abort the chain: non-retryable used to mean
 * "throw immediately", which silenced the fallback whenever the primary's
 * model was deprecated and degraded every agent to deterministic output.
 * Only non-Llm errors (aborts, programming bugs) rethrow untouched.
 */
class FallbackText implements TextGenerationClient {
  readonly kind = "TextGeneration" as const;
  constructor(
    private readonly chain: TextGenerationClient[],
    private readonly onHardFailure?: (providerId: string) => void,
  ) {}
  get providerId(): string {
    return this.chain[0]?.providerId ?? "none";
  }
  get model(): string {
    return this.chain[0]?.model ?? "none";
  }
  async complete<T = unknown>(
    options: CompleteOptions & { responseSchema?: z.ZodType<T> },
  ): Promise<CompleteResult<T>> {
    let lastError: unknown;
    for (const client of this.chain) {
      try {
        return await client.complete(options);
      } catch (err) {
        lastError = err;
        if (err instanceof LlmError) {
          if (isProviderDead(err)) this.onHardFailure?.(client.providerId);
          continue; // try the next provider — a failure here is why we have one
        }
        throw err;
      }
    }
    throw lastError;
  }
}

class FallbackDecision implements TypedDecisionClient {
  readonly kind = "TypedDecision" as const;
  constructor(
    private readonly chain: TypedDecisionClient[],
    private readonly onHardFailure?: (providerId: string) => void,
  ) {}
  get providerId(): string {
    return this.chain[0]?.providerId ?? "none";
  }
  get model(): string {
    return this.chain[0]?.model ?? "none";
  }
  async decide(request: DecisionRequest): Promise<DecisionResult> {
    let lastError: unknown;
    for (const client of this.chain) {
      try {
        return await client.decide(request);
      } catch (err) {
        lastError = err;
        if (err instanceof LlmError) {
          if (isProviderDead(err)) this.onHardFailure?.(client.providerId);
          continue;
        }
        throw err;
      }
    }
    throw lastError;
  }
}

/**
 * Resolves per-agent clients from ModelRouting. Holds the routing object BY
 * REFERENCE and builds providers on demand — so live edits to the routing
 * (config PUT from the UI) apply immediately, even mid-run. Usage flows to
 * the sink for budget metering. Mock instances persist across rebuilds so
 * script registration and call counting keep working.
 */
export class LlmRouter {
  readonly mocks: MockHandles;

  /**
   * Circuit breaker: providerIds that answered with a hard failure (bad auth,
   * endpoint gone). They are dropped from fallback chains for the rest of the
   * process — a dead fallback retried on every call wastes latency and tokens.
   */
  private readonly deadProviders = new Set<string>();

  constructor(
    private readonly routing: ModelRouting,
    private readonly env: Record<string, string | undefined>,
    private readonly sink?: UsageSink,
  ) {
    this.mocks = { mockText: new MockTextClient(), mockDecision: new MockDecisionClient() };
  }

  /** All provider configs, for diagnostics/UI. */
  providerConfigs(): ProviderConfig[] {
    return this.routing.providers;
  }

  /** Resolve a provider by id, building fresh from the CURRENT routing. */
  private providerFor(id: string): TextGenerationClient | TypedDecisionClient | null {
    const config = this.routing.providers.find((p) => p.providerId === id);
    if (!config) return null;
    return buildProvider(config, this.env, this.mocks);
  }

  private chainFor(
    agentId: string,
    kind: "TextGeneration" | "TypedDecision",
  ): Array<TextGenerationClient | TypedDecisionClient> {
    const route = this.routing.routes[agentId];
    if (!route) {
      throw new LlmError("unknown", `no route configured for agent '${agentId}'`, "router");
    }
    const ids = [route.providerId, ...(route.fallbackProviderId ? [route.fallbackProviderId] : [])];
    const chain: Array<TextGenerationClient | TypedDecisionClient> = [];
    for (const id of ids) {
      if (this.deadProviders.has(id)) continue; // tripped breaker — skip silently
      const provider = this.providerFor(id);
      if (!provider) continue;
      if (provider.kind !== kind) continue; // capability mismatch = unavailable
      chain.push(this.meter(provider, agentId));
    }
    return chain;
  }

  private meter(provider: TextGenerationClient | TypedDecisionClient, agentId: string) {
    return provider.kind === "TextGeneration"
      ? new MeteredText(provider, agentId, this.sink)
      : new MeteredDecision(provider, agentId, this.sink);
  }

  text(agentId: string): TextGenerationClient {
    const chain = this.chainFor(agentId, "TextGeneration") as TextGenerationClient[];
    if (chain.length === 0) {
      throw new LlmError("unknown", `no TextGeneration provider available for '${agentId}'`, "router");
    }
    return new FallbackText(chain, (id) => this.deadProviders.add(id));
  }

  /**
   * True when the agent's text route resolves only to a MockTextClient that
   * has no script for it — i.e. "no real LLM configured". Callers then skip
   * LLM paths entirely (deterministic modes) instead of crashing mid-run.
   */
  isUnscriptedMock(agentId: string): boolean {
    const route = this.routing.routes[agentId];
    const ids = [route?.providerId, route?.fallbackProviderId].filter((id): id is string => Boolean(id));
    let sawAnyProvider = false;
    for (const id of ids) {
      const provider = this.providerFor(id);
      if (!provider || provider.kind !== "TextGeneration") continue;
      sawAnyProvider = true;
      if (provider instanceof MockTextClient) {
        return !provider.has(agentId);
      }
      return false; // a real provider is configured
    }
    return sawAnyProvider;
  }

  decision(agentId: string): TypedDecisionClient {
    const chain = this.chainFor(agentId, "TypedDecision") as TypedDecisionClient[];
    if (chain.length === 0) {
      throw new LlmError("unknown", `no TypedDecision provider available for '${agentId}'`, "router");
    }
    return new FallbackDecision(chain, (id) => this.deadProviders.add(id));
  }
}

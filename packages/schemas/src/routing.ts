import { z } from "zod";
import { CapabilityKindSchema } from "./agent.js";

export const ProviderAdapterSchema = z.enum([
  "anthropic",
  "openai",
  "gemini",
  "ollama",
  "jev",
  "openrouter",
  "mock-text",
  "mock-decision",
]);
export type ProviderAdapter = z.infer<typeof ProviderAdapterSchema>;

/**
 * Provider configuration. NOTE: `apiKeyEnv` is the NAME of an environment
 * variable — API keys are never persisted to disk by VibeFix.
 */
export const ProviderConfigSchema = z.object({
  providerId: z.string().regex(/^[a-z][a-z0-9-]*$/),
  kind: CapabilityKindSchema,
  adapter: ProviderAdapterSchema,
  baseUrl: z.string().url().optional(),
  apiKeyEnv: z.string().optional(),
  defaultModel: z.string().min(1),
  contextWindowTokens: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive(),
  pricePerMTokInput: z.number().optional(),
  pricePerMTokOutput: z.number().optional(),
  enabled: z.boolean().default(true),
});
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

export const AgentRouteSchema = z.object({
  providerId: z.string().min(1),
  model: z.string().optional(),
  fallbackProviderId: z.string().optional(),
});
export type AgentRoute = z.infer<typeof AgentRouteSchema>;

export const BudgetsSchema = z.object({
  runMaxTokens: z.number().int().positive(),
  agentMaxTokens: z.number().int().positive().optional(),
  maxChangesPerRun: z.number().int().positive().default(10),
  maxRetriesPerChange: z.number().int().nonnegative().default(2),
  /** Warn at this fraction of runMaxTokens. */
  warnFraction: z.number().min(0).max(1).default(0.8),
});
export type Budgets = z.infer<typeof BudgetsSchema>;

/** Per-agent model routing. Decision roles → TypedDecision providers; generative roles → text. */
export const ModelRoutingSchema = z.object({
  providers: z.array(ProviderConfigSchema),
  routes: z.record(z.string(), AgentRouteSchema),
  budgets: BudgetsSchema,
});
export type ModelRouting = z.infer<typeof ModelRoutingSchema>;

/**
 * Real-models-only default routing. No mock providers: agents without a key
 * degrade to deterministic analysis, and the engineer REFUSES to run rather
 * than make placeholder edits. Providers are enabled by default; actual
 * availability is gated by the presence of their API key in the environment.
 */
export const DEFAULT_MODEL_ROUTING: ModelRouting = {
  providers: [
    {
      providerId: "gemini",
      kind: "TextGeneration",
      adapter: "gemini",
      apiKeyEnv: "GEMINI_API_KEY",
      defaultModel: "gemini-3.5-flash",
      contextWindowTokens: 1_000_000,
      maxOutputTokens: 65_536,
      pricePerMTokInput: 0.3,
      pricePerMTokOutput: 2.5,
      enabled: true,
    },
    {
      providerId: "anthropic",
      kind: "TextGeneration",
      adapter: "anthropic",
      apiKeyEnv: "ANTHROPIC_API_KEY",
      defaultModel: "claude-sonnet-5",
      contextWindowTokens: 200_000,
      maxOutputTokens: 16_384,
      pricePerMTokInput: 3,
      pricePerMTokOutput: 15,
      enabled: false,
    },
    {
      providerId: "openai",
      kind: "TextGeneration",
      adapter: "openai",
      apiKeyEnv: "OPENAI_API_KEY",
      defaultModel: "gpt-5.2",
      contextWindowTokens: 200_000,
      maxOutputTokens: 16_384,
      enabled: false,
    },
    {
      providerId: "ollama",
      kind: "TextGeneration",
      adapter: "ollama",
      baseUrl: "http://localhost:11434",
      defaultModel: "qwen2.5-coder:14b",
      contextWindowTokens: 32_000,
      maxOutputTokens: 8_192,
      enabled: false,
    },
    {
      providerId: "openrouter",
      kind: "TypedDecision",
      adapter: "openrouter",
      apiKeyEnv: "OPENROUTER_API_KEY",
      defaultModel: "typesafe/jev-latest",
      contextWindowTokens: 32_000,
      maxOutputTokens: 2_048,
      enabled: true,
    },
    {
      providerId: "jev",
      kind: "TypedDecision",
      adapter: "jev",
      apiKeyEnv: "TYPESAFE_API_KEY",
      defaultModel: "jev-latest",
      contextWindowTokens: 32_000,
      maxOutputTokens: 2_048,
      enabled: true,
    },
  ],
  routes: {
    cartographer: { providerId: "gemini", fallbackProviderId: "anthropic" },
    "test-surveyor": { providerId: "gemini", fallbackProviderId: "anthropic" },
    "smell-detector": { providerId: "gemini", fallbackProviderId: "anthropic" },
    "arch-auditor": { providerId: "gemini", fallbackProviderId: "anthropic" },
    "risk-assessor": { providerId: "openrouter", fallbackProviderId: "jev" },
    synthesis: { providerId: "openrouter", fallbackProviderId: "jev" },
    "harness-builder": { providerId: "gemini", fallbackProviderId: "anthropic" },
    engineer: { providerId: "gemini", fallbackProviderId: "anthropic" },
    verifier: { providerId: "openrouter", fallbackProviderId: "jev" },
    docent: { providerId: "gemini", fallbackProviderId: "anthropic" },
  },
  budgets: {
    runMaxTokens: 4_000_000,
    maxChangesPerRun: 10,
    maxRetriesPerChange: 2,
    warnFraction: 0.8,
  },
};

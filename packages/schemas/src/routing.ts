import { z } from "zod";
import { CapabilityKindSchema } from "./agent.js";

export const ProviderAdapterSchema = z.enum([
  "anthropic",
  "openai",
  "gemini",
  "gemini-decision",
  "ollama",
  "jev",
  "openrouter",
  "openrouter-text",
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
      defaultModel: "gemini-2.5-flash",
      contextWindowTokens: 1_000_000,
      maxOutputTokens: 8_192,
      pricePerMTokInput: 0.075,
      pricePerMTokOutput: 0.3,
      enabled: true,
    },
    {
      providerId: "anthropic",
      kind: "TextGeneration",
      adapter: "anthropic",
      apiKeyEnv: "ANTHROPIC_API_KEY",
      defaultModel: "claude-3-5-sonnet-20241022",
      contextWindowTokens: 200_000,
      maxOutputTokens: 8_192,
      pricePerMTokInput: 3,
      pricePerMTokOutput: 15,
      enabled: false,
    },
    {
      providerId: "openai",
      kind: "TextGeneration",
      adapter: "openai",
      apiKeyEnv: "OPENAI_API_KEY",
      defaultModel: "gpt-4o-mini",
      contextWindowTokens: 128_000,
      maxOutputTokens: 4_096,
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
      // Typed decisions straight against Google's API — no OpenRouter
      // middleman for the small, frequent decision calls (risk scores,
      // verdicts, ranking). Same key as the text route above.
      providerId: "gemini-decision",
      kind: "TypedDecision",
      adapter: "gemini-decision",
      apiKeyEnv: "GEMINI_API_KEY",
      defaultModel: "gemini-2.5-flash",
      contextWindowTokens: 1_000_000,
      maxOutputTokens: 2_048,
      pricePerMTokInput: 0.075,
      pricePerMTokOutput: 0.3,
      enabled: true,
    },
    {
      // Free OpenRouter model — the cost-zero fallback when direct Gemini
      // is down/overloaded. :free models are rate-limited, which is fine for
      // a fallback that should rarely carry traffic.
      providerId: "openrouter",
      kind: "TypedDecision",
      adapter: "openrouter",
      apiKeyEnv: "OPENROUTER_API_KEY",
      defaultModel: "meta-llama/llama-3.3-70b-instruct:free",
      contextWindowTokens: 131_072,
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
    {
      // Text generation through OpenRouter — the practical fallback when a
      // direct provider (e.g. Gemini) is down/overloaded and no Anthropic or
      // OpenAI key is present. Same key as the decision route above.
      providerId: "openrouter-text",
      kind: "TextGeneration",
      adapter: "openrouter-text",
      apiKeyEnv: "OPENROUTER_API_KEY",
      defaultModel: "google/gemini-2.5-flash",
      contextWindowTokens: 1_000_000,
      maxOutputTokens: 8_192,
      pricePerMTokInput: 0.075,
      pricePerMTokOutput: 0.3,
      enabled: true,
    },
  ],
  routes: {
    cartographer: { providerId: "gemini", fallbackProviderId: "openrouter-text" },
    historian: { providerId: "gemini", fallbackProviderId: "openrouter-text" },
    "test-surveyor": { providerId: "gemini", fallbackProviderId: "openrouter-text" },
    "smell-detector": { providerId: "gemini", fallbackProviderId: "openrouter-text" },
    "arch-auditor": { providerId: "gemini", fallbackProviderId: "openrouter-text" },
    "consistency-sentinel": { providerId: "gemini", fallbackProviderId: "openrouter-text" },
    "security-agent": { providerId: "gemini", fallbackProviderId: "openrouter-text" },
    "risk-assessor": { providerId: "gemini-decision", fallbackProviderId: "openrouter" },
    synthesis: { providerId: "gemini-decision", fallbackProviderId: "openrouter" },
    minimality: { providerId: "gemini-decision", fallbackProviderId: "openrouter" },
    "harness-builder": { providerId: "gemini", fallbackProviderId: "openrouter-text" },
    engineer: { providerId: "gemini", fallbackProviderId: "openrouter-text" },
    verifier: { providerId: "gemini-decision", fallbackProviderId: "openrouter" },
    "principle-reviewer": { providerId: "gemini-decision", fallbackProviderId: "openrouter" },
    "regression-sentinel": { providerId: "gemini-decision", fallbackProviderId: "openrouter" },
    docent: { providerId: "gemini", fallbackProviderId: "openrouter-text" },
  },
  budgets: {
    runMaxTokens: 2_000_000, // Reduced from 4M for better cost control
    maxChangesPerRun: 10,
    maxRetriesPerChange: 2,
    warnFraction: 0.8,
  },
};

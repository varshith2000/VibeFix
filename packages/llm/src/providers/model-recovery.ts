import { LlmError } from "../errors.js";

/**
 * Live model recovery. Model slugs rot: Google deprecates old flash tiers
 * for new keys, OpenRouter free tiers get promoted to paid. Instead of
 * hardcoding slugs that expire, learn the replacement from the provider's
 * own answer and remember it for the process lifetime.
 */

/** Per-provider Gemini model overrides learned from 404 "no longer available" bodies. */
const geminiOverrides = new Map<string, string>();

export function geminiModelOverride(providerId: string): string | undefined {
  return geminiOverrides.get(providerId);
}

export function rememberGeminiModel(providerId: string, model: string): void {
  geminiOverrides.set(providerId, model);
}

/**
 * Google's deprecation body reads: "Please update your code to use
 * models/gemini-3.6-flash for the latest features…". Extract that slug —
 * it is Google's own recommendation, not a guess.
 */
export function suggestedGeminiModel(err: unknown): string | null {
  if (!(err instanceof LlmError) || err.status !== 404) return null;
  const match = err.message.match(/models\/([a-zA-Z0-9][a-zA-Z0-9._-]{2,})/);
  return match?.[1] ?? null;
}

// ---------------------------------------------------------------- OpenRouter

export interface OpenRouterModelEntry {
  id: string;
  context_length?: number;
  pricing?: { prompt?: string; completion?: string };
}

let freeModelCache: { model: string; at: number } | null = null;
const FREE_MODEL_TTL_MS = 60 * 60 * 1_000;

/**
 * Pick a currently-free model from OpenRouter's live catalog. Free slugs
 * churn (":free" variants get retired), so query /api/v1/models and choose
 * deterministically: proven general instruction-tuned families first.
 * `exclude` skips slugs that just 404'd.
 *
 * Scoring is empirical: niche/experimental free models (music generators,
 * safety classifiers, note-taking previews, tiny MoE mixes) win on raw
 * heuristics like context size but answer decision prompts with prose —
 * only verified instruction models reliably honor the JSON schema contract.
 */
export async function discoverFreeOpenRouterModel(
  baseUrl: string | undefined,
  apiKey: string,
  exclude: ReadonlySet<string> = new Set(),
): Promise<string | null> {
  const cached = freeModelCache;
  if (cached && Date.now() - cached.at < FREE_MODEL_TTL_MS && !exclude.has(cached.model)) {
    return cached.model;
  }
  try {
    const res = await fetch(`${baseUrl ?? "https://openrouter.ai"}/api/v1/models`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: OpenRouterModelEntry[] };
    const free = (body.data ?? []).filter(
      (m) =>
        typeof m.id === "string" &&
        !exclude.has(m.id) &&
        Number(m.pricing?.prompt ?? "1") === 0 &&
        Number(m.pricing?.completion ?? "1") === 0,
    );
    // Not general instruction models — never pick these for decisions.
    const UNUSABLE = /safety|omni|lyria|clip|preview|bunny|note|inkling|nano|art/;
    const score = (m: OpenRouterModelEntry): number => {
      const id = m.id.toLowerCase();
      if (UNUSABLE.test(id)) return -1;
      // Prefer proven general instruction models, largest reliable first.
      if (id.includes("llama-3.3-70b")) return 100;
      if (id.includes("nemotron") && id.includes("super")) return 95;
      if (id.includes("gemma") && id.includes("-it")) return 90;
      if (id.includes("qwen")) return 80;
      if (id.includes("glm")) return 70;
      if (id.includes("nemotron")) return 60;
      if (id.includes("llama-3") && id.includes("70b")) return 55;
      if (id.includes("deepseek")) return 50;
      if (id.includes("mistral")) return 40;
      return 10 + Math.min((m.context_length ?? 0) / 100_000, 20);
    };
    free.sort((a, b) => score(b) - score(a) || a.id.localeCompare(b.id));
    const best = free[0];
    if (best && score(best) > 0) {
      freeModelCache = { model: best.id, at: Date.now() };
      return best.id;
    }
    return null;
  } catch {
    return null;
  }
}

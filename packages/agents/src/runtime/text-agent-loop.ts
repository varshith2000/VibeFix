import type { z } from "zod";
import { LlmError } from "@vibefix/llm";
import type { AgentExecutionContext } from "../contract.js";

/**
 * One-shot structured enrichment call. Deterministic-first design: agents
 * build their artifacts from facts regardless; the LLM refines narratives.
 * Any LLM failure degrades gracefully to the deterministic content.
 */
export async function enrich<T>(
  ctx: AgentExecutionContext,
  input: { system: string; prompt: string; schema: z.ZodType<T>; maxTokens?: number },
): Promise<T | undefined> {
  if (!ctx.llm) return undefined;
  const llm = ctx.llm;

  const attempt = async (prompt: string): Promise<T | undefined> => {
    // Optimize token usage by using lower default maxTokens for most operations
    const optimizedMaxTokens = Math.min(input.maxTokens ?? 1_024, 2_048);
    const result = await llm.complete<T>({
      system: input.system,
      messages: [{ role: "user", content: prompt }],
      responseSchema: input.schema,
      maxTokens: optimizedMaxTokens,
      metadata: { agentId: ctx.def.agentId },
    });
    return result.structured;
  };

  // Say which model is generating — the call can take seconds and the event
  // stream should show live intent, not silence.
  await ctx.progress(`generating via ${llm.providerId} (${llm.model})`);

  try {
    return await attempt(input.prompt);
  } catch (err) {
    // Malformed/unparseable JSON gets ONE repair round with a stricter
    // instruction — models occasionally wrap the payload in prose or fences
    // even in JSON mode, and degrading to heuristics on the first miss makes
    // every downstream finding shallower than designed.
    const malformed =
      (err instanceof LlmError && err.kind === "invalid-response") || err instanceof Error && err.name === "ZodError";
    if (malformed) {
      try {
        return await attempt(
          input.prompt +
            "\n\nCRITICAL: Respond with ONLY the JSON object matching the required schema. " +
            "No explanations, no prose before or after, no markdown code fences.",
        );
      } catch (retryErr) {
        await ctx.progress(
          "llm enrichment failed after repair retry — using deterministic content",
          String(retryErr instanceof Error ? retryErr.message : retryErr).slice(0, 300),
        );
        return undefined;
      }
    }
    // Other failures (auth, network after fallbacks, dead providers):
    // degrade loudly, never silently — a dead provider returning mid-quality
    // output is what makes runs look like demo data.
    const errorMessage = err instanceof Error ? err.message : String(err);
    await ctx.progress("llm enrichment failed — using deterministic content", errorMessage.slice(0, 300));
    return undefined;
  }
}

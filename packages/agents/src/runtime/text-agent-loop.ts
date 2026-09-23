import type { z } from "zod";
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
  try {
    // Optimize token usage by using lower default maxTokens for most operations
    const optimizedMaxTokens = Math.min(input.maxTokens ?? 1_024, 2_048);
    
    const result = await ctx.llm.complete<T>({
      system: input.system,
      messages: [{ role: "user", content: input.prompt }],
      responseSchema: input.schema,
      maxTokens: optimizedMaxTokens,
      metadata: { agentId: ctx.def.agentId },
    });
    return result.structured;
  } catch (err) {
    // Graceful degradation, but LOUD: a silently dead provider is what makes
    // runs look like demo data. Record the failure in the run's event log.
    const errorMessage = err instanceof Error ? err.message : String(err);
    await ctx.progress("llm enrichment failed — using deterministic content", errorMessage.slice(0, 300));
    return undefined;
  }
}

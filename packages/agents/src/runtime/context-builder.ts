import type { ArtifactKind, EvidenceArtifact } from "@vibefix/schemas";
import type { AgentExecutionContext } from "../contract.js";

/** Artifacts whose *reasoning* must never reach fresh-context reviewers. */
const FRESH_CONTEXT_EXCLUDED: ArtifactKind[] = ["change-attempt"];

/**
 * Assembles the evidence bundle for an agent from its definition.consumes.
 * Fresh context is a DATA-FLOW GUARANTEE, not a prompt promise: for
 * freshContext agents the builder structurally refuses to include
 * change-attempt reasoning — verifiers see diff + proposal + baseline only.
 */
export async function buildEvidenceBundle(ctx: AgentExecutionContext): Promise<string> {
  const parts: string[] = [];
  for (const kind of ctx.def.consumes) {
    if (ctx.def.freshContext && FRESH_CONTEXT_EXCLUDED.includes(kind)) continue;
    const artifact = await ctx.store.latest(kind);
    if (!artifact) {
      parts.push(`## ${kind}\n(not available — treat as unknown)`);
      continue;
    }
    parts.push(`## ${kind}\n${renderArtifact(artifact)}`);
  }
  return parts.join("\n\n");
}

function renderArtifact(artifact: EvidenceArtifact): string {
  const json = JSON.stringify(artifact.data, null, 2);
  // Budget: never hand an agent more than ~30k chars of a single artifact.
  return json.length > 30_000 ? `${json.slice(0, 30_000)}\n... (truncated)` : json;
}

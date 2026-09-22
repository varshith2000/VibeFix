import { promises as fs } from "node:fs";
import path from "node:path";
import { globMatchAny } from "@vibefix/core";
import type { ChangeAttemptArtifact } from "@vibefix/schemas";
import { z } from "zod";
import { passed, rejected, failed, type AgentExecutionContext, type VibeFixAgent } from "../contract.js";
import { definitionFor } from "../definitions.js";

// Lenient on purpose: models under JSON mode sometimes omit fields or wrap
// values oddly. A repairable answer beats a rejected attempt.
const EditsSchema = z.object({
  rationale: z.string().catch(""),
  edits: z
    .array(
      z.object({
        path: z.string().min(1),
        newContent: z.string(),
      }),
    )
    .default([]),
});

/**
 * The ONLY agent that writes code. Receives exactly one proposal, works in
 * an isolated worktree behind the Change Firewall. Move/extract/rename only —
 * never rewrite logic. Without a real LLM it performs a labeled, harmless
 * boundary-marker edit inside scope so the full loop stays demonstrable.
 */
export class RefactoringEngineer implements VibeFixAgent {
  definition = definitionFor("engineer");

  async execute(ctx: AgentExecutionContext) {
    if (!ctx.proposal || !ctx.worktree || !ctx.firewall) {
      return rejected("engineer requires a proposal, worktree and firewall");
    }
    const { proposal, worktree, firewall } = ctx;

    try {
      await ctx.progress(`reading files in scope of ${proposal.proposalId}`);
      const codeFiles = ctx.tools.snapshot.files.filter((f) =>
        globMatchAny(proposal.filesInScope, f.path),
      );
      const inScope = codeFiles.filter((f) => /\.(ts|tsx|js|jsx|py)$/.test(f.path)).slice(0, 25);

      let rationale: string;
      const filesTouched: string[] = [];
      const write = async (relativePath: string, newContent: string): Promise<boolean> => {
        const decision = firewall.canWrite(relativePath);
        if (!decision.allowed) {
          const record = firewall.recordViolation(relativePath, decision.reason ?? "");
          await ctx.store.write({
            kind: "firewall-violation",
            producer: ctx.def.agentId,
            runId: ctx.runState.runId,
            data: {
              proposalId: proposal.proposalId,
              attempt: ctx.attempt ?? 0,
              path: relativePath,
              reason: decision.reason ?? "blocked",
              ts: new Date().toISOString(),
            },
          });
          if (record.autoReject) throw new Error(`firewall auto-reject: ${decision.reason}`);
          return false;
        }
        const abs = path.join(worktree.path, ...relativePath.split("/"));
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, newContent, "utf8");
        if (!filesTouched.includes(relativePath)) filesTouched.push(relativePath);
        return true;
      };

      if (ctx.llm) {
        await ctx.progress("planning minimal edits with the model");
        const fileContents: Record<string, string> = {};
        for (const f of inScope) {
          try {
            fileContents[f.path] = await fs.readFile(path.join(worktree.path, ...f.path.split("/")), "utf8");
          } catch {
            // new files are fine
          }
        }
        const system =
          "You are the Refactoring Engineer in VibeFix, an automated behavior-preserving refactoring system.\n" +
          "PRIME DIRECTIVE: the program's observable behavior must not change. You are moving structure, never logic.\n\n" +
          "WORK RULES:\n" +
          "1. Implement EXACTLY the stated proposal — nothing else, no drive-by edits, no reformatting of untouched code.\n" +
          "2. Move / extract / rename / delete-dead-code. NEVER rewrite business logic, change control flow, alter " +
          "error semantics, reorder side effects, or change what functions return.\n" +
          "3. Preserve every public interface: same exported names, signatures, routes, response shapes. " +
          "Call sites keep working unchanged.\n" +
          "4. When extracting: the extracted unit keeps the ORIGINAL code verbatim as its body; the original site " +
          "becomes a call/delegation to it.\n" +
          "5. When deduplicating: choose the most complete copy as the shared implementation; others become calls.\n" +
          "6. Smallest diff that honestly achieves the proposal's stated goal.\n" +
          "7. Touch ONLY paths that appear in filesInScope. New files ARE allowed if they are inside a scoped directory.\n" +
          "8. No dependency changes, no config changes, no schema changes, no comment-only changes.\n" +
          "9. Respect product intent constraints when provided — do not redesign the product.\n\n" +
          "OUTPUT: a single JSON object {\"rationale\": string, \"edits\": [{\"path\": string, \"newContent\": string}]} " +
          "with full new content for every file you modify or create (files you don't touch must NOT appear).";

        const intentArtifact = await ctx.store.latest("product-intent");
        let intentBlock: unknown = null;
        if (intentArtifact) {
          try {
            intentBlock = intentArtifact.data;
          } catch {
            intentBlock = null;
          }
        }

        const planPrompt = JSON.stringify(
          {
            proposal: {
              id: proposal.proposalId,
              title: proposal.title,
              problem: proposal.problem,
              evidence: proposal.evidence,
              filesInScope: proposal.filesInScope,
              constraints: proposal.constraints,
              expectedBenefit: proposal.expectedBenefit,
              ...(proposal.explanation
                ? {
                    currentState: proposal.explanation.currentState,
                    proposedState: proposal.explanation.proposedState,
                  }
                : {}),
            },
            productIntent: intentBlock,
            mode: ctx.runState.mode,
            forbiddenZones: ctx.forbiddenZones ?? [],
            files: fileContents,
          },
          null,
          2,
        );

        // One repair round: if the model's JSON doesn't match the schema,
        // tell it exactly why and ask again before giving up on the attempt.
        type EditsPlan = z.output<typeof EditsSchema>;
        let plan: EditsPlan | undefined;
        let lastError = "";
        for (let round = 0; round < 2 && !plan; round++) {
          try {
            const result = await ctx.llm.complete({
              system,
              messages: [
                { role: "user", content: planPrompt },
                ...(round > 0
                  ? [
                      {
                        role: "assistant" as const,
                        content: "(previous answer was invalid)",
                      },
                      {
                        role: "user" as const,
                        content:
                          `Your previous answer failed validation: ${lastError}\n` +
                          'Return ONLY the JSON object {"rationale": "...", "edits": [{"path": "...", "newContent": "..."}]} — ' +
                          "both fields are required, and edits must be a non-empty array.",
                      },
                    ]
                  : []),
              ],
              responseSchema: EditsSchema as z.ZodType<EditsPlan>,
              maxTokens: 16_384,
              temperature: 0,
              metadata: { agentId: ctx.def.agentId, step: "implement" },
            });
            // .default()/.catch() make the schema's input type looser than its
            // output; complete<T> infers the input side, so cast to the output.
            plan = result.structured as EditsPlan | undefined;
          } catch (err) {
            lastError = String(err instanceof Error ? err.message : err).slice(0, 400);
            await ctx.progress(`model output failed validation (round ${round + 1})`, lastError);
          }
        }
        if (!plan) {
          return failed(new Error(`model output failed schema validation twice: ${lastError}`));
        }
        if (plan.edits.length === 0) {
          return rejected("model proposed no edits — nothing to implement");
        }
        rationale = plan.rationale;
        await ctx.progress(`applying ${plan.edits.length} edits`);
        for (const edit of plan.edits) {
          await write(edit.path.replace(/\\/g, "/"), edit.newContent);
        }
      } else {
        // Real models only: without an LLM the engineer REFUSES to touch code.
        // Deterministic analysis upstream is fine — fake modifications are not.
        return rejected(
          "no text model is routed to the engineer — VibeFix refuses to make placeholder modifications. " +
            "Route a real model (Gemini, Anthropic, OpenAI or Ollama) in ⚙ Settings and retry.",
        );
      }

      const attempt: ChangeAttemptArtifact = {
        proposalId: proposal.proposalId,
        attempt: ctx.attempt ?? 0,
        worktreePath: worktree.path,
        rationale,
        filesTouched,
      };
      const artifact = await ctx.store.write({
        kind: "change-attempt",
        producer: ctx.def.agentId,
        runId: ctx.runState.runId,
        data: attempt,
      });
      return passed([artifact.artifactId]);
    } catch (err) {
      return failed(err);
    }
  }
}

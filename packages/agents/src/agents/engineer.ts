import { promises as fs } from "node:fs";
import path from "node:path";
import { globMatchAny } from "@vibefix/core";
import type { ChangeAttemptArtifact } from "@vibefix/schemas";
import { z } from "zod";
import { passed, rejected, failed, type AgentExecutionContext, type VibeFixAgent } from "../contract.js";
import { definitionFor } from "../definitions.js";

const EditsSchema = z.object({
  rationale: z.string().min(1),
  edits: z.array(
    z.object({
      path: z.string().min(1),
      newContent: z.string(),
    }),
  ),
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
        const result = await ctx.llm.complete({
          system:
            "You are the Refactoring Engineer in VibeFix. Prime directive: BEHAVIOR PRESERVATION.\n" +
            "Rules: implement EXACTLY the stated proposal; move/extract/rename, NEVER rewrite logic; " +
            "smallest possible diff; touch ONLY the listed files; no drive-by edits; no dependency changes; " +
            "no public API changes. Return full new content for each file you modify.",
          messages: [
            {
              role: "user",
              content: JSON.stringify(
                {
                  proposal: {
                    id: proposal.proposalId,
                    title: proposal.title,
                    problem: proposal.problem,
                    evidence: proposal.evidence,
                    filesInScope: proposal.filesInScope,
                    constraints: proposal.constraints,
                    expectedBenefit: proposal.expectedBenefit,
                  },
                  mode: ctx.runState.mode,
                  files: fileContents,
                },
                null,
                2,
              ),
            },
          ],
          responseSchema: EditsSchema,
          maxTokens: 8_192,
          temperature: 0,
          metadata: { agentId: ctx.def.agentId, step: "implement" },
        });
        const plan = result.structured;
        if (!plan) throw new Error("model returned no structured edits");
        rationale = plan.rationale;
        await ctx.progress(`applying ${plan.edits.length} edits`);
        for (const edit of plan.edits) {
          await write(edit.path.replace(/\\/g, "/"), edit.newContent);
        }
      } else {
        // Mock/demo mode: a labeled, harmless boundary marker inside scope.
        const target = inScope[0];
        if (!target) throw new Error("no in-scope code file to touch");
        rationale = `demo mode: appended a boundary marker comment to ${target.path} (no LLM provider configured)`;
        await ctx.progress("demo edit: boundary marker");
        let content = "";
        try {
          content = await fs.readFile(path.join(worktree.path, ...target.path.split("/")), "utf8");
        } catch {
          content = "";
        }
        const marker = `\n// vibefix(${proposal.proposalId}): boundary reviewed by VibeFix (demo edit)\n`;
        await write(target.path, `${content}${marker}`);
      }

      const attempt: ChangeAttemptArtifact = {
        proposalId: proposal.proposalId,
        attempt: ctx.attempt ?? 0,
        worktreePath: worktree.path,
        rationale,
        filesTouched: inScope.map((f) => f.path),
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

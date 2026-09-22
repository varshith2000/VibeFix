import { promises as fs } from "node:fs";
import path from "node:path";
import type { FindingsArtifact } from "@vibefix/schemas";
import { passed, failed, type AgentExecutionContext, type VibeFixAgent } from "../contract.js";
import { definitionFor } from "../definitions.js";
import { makeFinding } from "../shared/findings.js";

/**
 * Security Agent — read-only. Surfaces hardcoded secrets, unsafe patterns,
 * and sensitive logging. Findings are SEPARATE from stylistic refactoring.
 */
export class SecurityAgent implements VibeFixAgent {
  definition = definitionFor("security-agent");

  async execute(ctx: AgentExecutionContext) {
    try {
      await ctx.progress("scanning for security risks");
      const findings: FindingsArtifact["findings"] = [];
      const files = ctx.tools.snapshot.files.filter(
        (f) =>
          /\.(ts|tsx|js|jsx|py|env|yml|yaml|json|toml)$/.test(f.path) &&
          !f.path.includes("node_modules") &&
          !f.path.includes("package-lock"),
      );

      const SECRET_PATTERNS: Array<{ name: string; re: RegExp; change: "none" }> = [
        { name: "AWS access key", re: /AKIA[0-9A-Z]{16}/g, change: "none" },
        { name: "private key block", re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g, change: "none" },
        { name: "generic API key assignment", re: /(?:api[_-]?key|secret[_-]?key|access[_-]?token)\s*[:=]\s*['"][^'"]{12,}['"]/gi, change: "none" },
        { name: "password literal", re: /password\s*[:=]\s*['"][^'"]{4,}['"]/gi, change: "none" },
      ];

      const UNSAFE: Array<{ name: string; re: RegExp; impact: string }> = [
        {
          name: "eval()",
          re: /\beval\s*\(/g,
          impact: "eval executes arbitrary code and is a common injection sink.",
        },
        {
          name: "child_process with shell",
          re: /exec\s*\(\s*[`'"].*\$\{/g,
          impact: "Shell interpolation of untrusted input enables command injection.",
        },
        {
          name: "SQL string concatenation",
          re: /(?:SELECT|INSERT|UPDATE|DELETE)[\s\S]{0,80}\+\s*(?:req\.|user|params)/gi,
          impact: "String-built SQL risks injection; prefer parameterized queries.",
        },
        {
          name: "sensitive console logging",
          re: /console\.(?:log|info|debug|error)\([^)]*(?:password|token|secret|authorization)[^)]*\)/gi,
          impact: "Secrets in logs leak credentials into log aggregators and crash dumps.",
        },
      ];

      for (const f of files.slice(0, 600)) {
        let content: string;
        try {
          content = await fs.readFile(path.join(ctx.repoPath, ...f.path.split("/")), "utf8");
        } catch {
          continue;
        }
        // Skip obvious false positives in lockfiles / huge JSON.
        if (content.length > 200_000) continue;

        for (const pat of SECRET_PATTERNS) {
          pat.re.lastIndex = 0;
          if (pat.re.test(content)) {
            findings.push(
              makeFinding({
                title: `Possible hardcoded secret: ${pat.name}`,
                location: f.path,
                evidence: [`pattern matched in ${f.path}`, "Security finding — remediate separately from style refactors"],
                impact: "Hardcoded credentials can be exfiltrated from the repository or build artifacts.",
                category: "security",
                recommendedChangeCategory: "none",
                confidence: 0.8,
              }),
            );
          }
        }

        for (const u of UNSAFE) {
          u.re.lastIndex = 0;
          if (u.re.test(content)) {
            findings.push(
              makeFinding({
                title: `Unsafe pattern: ${u.name}`,
                location: f.path,
                evidence: [`detected ${u.name} in ${f.path}`],
                impact: u.impact,
                category: "security",
                recommendedChangeCategory: "none",
                confidence: 0.7,
              }),
            );
          }
        }
      }

      // Cap noise — security scan can be chatty on large repos.
      const capped = findings.slice(0, 40);
      const artifact = await ctx.store.write({
        kind: "findings",
        producer: ctx.def.agentId,
        runId: ctx.runState.runId,
        data: {
          findings: capped,
          notes: ["security-agent", "security findings are informational — not auto-fixed in minimal mode"],
        } satisfies FindingsArtifact,
      });
      await ctx.progress(`${capped.length} security findings`);
      return passed([artifact.artifactId]);
    } catch (err) {
      return failed(err);
    }
  }
}

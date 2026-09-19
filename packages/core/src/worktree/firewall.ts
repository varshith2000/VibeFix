import type { ChangeProposal } from "@vibefix/schemas";
import { globMatchAny } from "../util/glob.js";

/** Paths no proposal may ever touch unless explicitly listed in its scope. */
const ALWAYS_PROTECTED: string[] = [
  ".git/**",
  ".vibefix/**",
  "**/*.lock",
  "**/package-lock.json",
  "**/pnpm-lock.yaml",
  "**/yarn.lock",
  "**/poetry.lock",
];

const MANIFESTS: string[] = ["package.json", "pyproject.toml", "requirements.txt", "go.mod", "Cargo.toml"];

export interface FirewallDecision {
  allowed: boolean;
  reason?: string;
}

/**
 * Enforces the Change Proposal's declared scope in CODE, not prompts.
 * Wraps every write-capable tool handed to the engineer. Two violations in
 * one attempt = the orchestrator auto-rejects the attempt.
 */
export class ChangeFirewall {
  private violations = 0;

  constructor(
    private readonly proposal: ChangeProposal,
    private readonly extraForbidden: readonly string[] = [],
  ) {}

  canWrite(relativePosixPath: string): FirewallDecision {
    const path = relativePosixPath.replace(/\\/g, "/");
    if (globMatchAny(ALWAYS_PROTECTED, path) && !this.proposal.filesInScope.includes(path)) {
      return { allowed: false, reason: `'${path}' matches an always-protected path` };
    }
    if (MANIFESTS.includes(path) && !this.proposal.filesInScope.includes(path)) {
      return { allowed: false, reason: `'${path}' is a manifest; it must be explicitly in scope to change` };
    }
    if (this.proposal.filesOutOfScope.some((p) => globMatchAny([p], path))) {
      return { allowed: false, reason: `'${path}' is explicitly out of scope for ${this.proposal.proposalId}` };
    }
    if (this.extraForbidden.some((p) => globMatchAny([p], path))) {
      return { allowed: false, reason: `'${path}' lies in a forbidden zone (risk or user declared do-not-touch)` };
    }
    if (!globMatchAny(this.proposal.filesInScope, path)) {
      return { allowed: false, reason: `'${path}' is outside the declared scope of ${this.proposal.proposalId}` };
    }
    return { allowed: true };
  }

  /** Records a blocked attempt. Returns true when the attempt must be auto-rejected. */
  recordViolation(path: string, reason: string): { violations: number; autoReject: boolean } {
    this.violations += 1;
    void path;
    void reason;
    return { violations: this.violations, autoReject: this.violations >= 2 };
  }

  get violationCount(): number {
    return this.violations;
  }
}

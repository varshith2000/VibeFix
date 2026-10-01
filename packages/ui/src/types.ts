/** Wire types matching @vibefix/schemas (kept local to keep the UI bundle lean). */

export type RunPhase =
  | "init"
  | "recon"
  | "diagnosis"
  | "riskAssessment"
  | "synthesis"
  | "minimality"
  | "awaitingApproval"
  | "harness"
  | "execution"
  | "report"
  | "completed";

export type RunStatus = "running" | "interrupted" | "paused" | "awaitingApproval" | "aborted" | "failed" | "completed";

export type AgentRunStatus = "queued" | "running" | "passed" | "failed" | "rejected" | "skipped" | "deferred";

export interface RunState {
  runId: string;
  repoPath: string;
  createdAt: string;
  updatedAt: string;
  status: RunStatus;
  phase: RunPhase;
  mode: "minimal" | "architecture" | "modernization";
  agentStates: Record<string, AgentRunStatus>;
  execution: { queue: string[]; currentIndex: number; attempt: number; stage: string };
  approval: { requested: boolean; decidedAt: string | null; approvedItems: string[]; mode: string | null };
  budget: { tokensSpent: number; changesCommitted: number; retriesUsed: number };
  error: string | null;
}

export interface AgentDefinition {
  agentId: string;
  role: string;
  label: string;
  phase: string;
  capability: "TextGeneration" | "TypedDecision";
  permission: "read-only" | "evidence-write" | "worktree-write";
  runsInPool: "recon" | "diagnosis" | "verification" | null;
  freshContext: boolean;
}

export interface RunEvent {
  eventId: string;
  runId: string;
  ts: string;
  seq: number;
  type: string;
  agentId?: string;
  proposalId?: string;
  message?: string;
  payload?: unknown;
}

export interface Finding {
  findingId: string;
  title: string;
  location: string;
  evidence: string[];
  impact: string;
  confidence: number;
  category: string;
  recommendedChangeCategory: string;
  /** Provenance: "ts-ast", "regex-heuristic", "import-graph", "llm-validated", ... */
  analyzer?: string;
  parserStatus?: string;
  risk: { value: number; band: "low" | "medium" | "high" | "forbidden"; rationale?: string };
  proposedChangeId: string | null;
}

export interface ChangeProposal {
  proposalId: string;
  title: string;
  problem: string;
  evidence: string[];
  filesInScope: string[];
  filesOutOfScope: string[];
  risk: { value: number; band: string; rationale?: string };
  expectedBenefit: string[];
  constraints: string[];
  priority: number;
  allowedInModes: string[];
  approvalStatus: string;
  explanation?: {
    currentState: string;
    proposedState: string;
    whyItMatters: string;
  };
  beforeAfterDiagram?: string;
}

export interface LedgerEntry {
  ledgerId: string;
  proposalId: string;
  attempt: number;
  verdict: "pending" | "passed" | "rejected" | "deferred";
  verifierNotes: string[];
  committedRef: string | null;
  diff: string;
  ts: string;
}

export interface ProviderConfig {
  providerId: string;
  kind: "TextGeneration" | "TypedDecision";
  adapter: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  defaultModel: string;
  contextWindowTokens: number;
  maxOutputTokens: number;
  pricePerMTokInput?: number;
  pricePerMTokOutput?: number;
  enabled: boolean;
}

export interface RepoConfig {
  routing: {
    providers: ProviderConfig[];
    routes: Record<string, { providerId: string; model?: string; fallbackProviderId?: string }>;
    budgets: {
      runMaxTokens: number;
      agentMaxTokens?: number;
      maxChangesPerRun: number;
      maxRetriesPerChange: number;
      warnFraction: number;
    };
  };
  defaultMode: string;
  protectedPaths: string[];
  executionPolicy: { allowRepositoryCommands: boolean };
  analyzer: { sidecarCommand?: string[]; sidecarProtocolVersion: number };
}

export interface Report {
  stateOfCodebase: string;
  existingArchitecture?: string;
  existingArchitectureDiagram?: string;
  changeExplainers: Array<{
    proposalId: string;
    what: string;
    why: string;
    principle: string;
    currentState?: string;
    proposedState?: string;
    whyItMatters?: string;
    beforeAfterDiagram?: string;
  }>;
  whatDidNotChange: string[];
  learningSummary: string;
  totals: {
    changesProposed: number;
    changesCommitted: number;
    changesRejected: number;
    changesDeferred: number;
    publicApiChanges: number;
    tokensSpent: number;
  };
}

export interface ProductIntent {
  productSummary: string;
  coreAreas: string[];
  frozenAreas: string[];
  activeChurnAreas: string[];
  intentConstraints: string[];
  sources: string[];
  notes?: string[];
}

export interface ProjectIntelligence {
  graph: {
    summary: {
      languages: string[];
      frameworks: string[];
      entrypoints: string[];
      buildSystem: string | null;
      packageManager: string | null;
      testFrameworks: string[];
      loc: number;
      fileCount: number;
      unknowns: string[];
    };
  } | null;
  intent: ProductIntent | null;
  survey: {
    frameworks: string[];
    testFileCount: number;
    canTest: boolean;
    untestedPaths: string[];
  } | null;
  findingCounts: {
    total: number;
    byCategory: Record<string, number>;
    byBand: Record<string, number>;
  };
  health: {
    architecture: number;
    maintainability: number;
    testing: number;
    security: number;
    dependencyHygiene: number;
    documentation: number;
  };
}

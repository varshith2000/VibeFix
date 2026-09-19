import {
  NodeFsFacts,
  NodeTestRunner,
  RegexImportGraph,
  computeMetrics,
  type FileMetrics,
  type RepoSnapshot,
} from "@vibefix/adapters";
import type { AgentExecutionInput, AgentExecutorPort, RunServices } from "@vibefix/core";
import { LlmRouter } from "@vibefix/llm";
import type { AgentDefinition } from "@vibefix/schemas";
import { ArchitectureAuditor } from "./agents/arch-auditor.js";
import { Cartographer } from "./agents/cartographer.js";
import { Docent } from "./agents/docent.js";
import { HarnessBuilder } from "./agents/harness-builder.js";
import { RefactoringEngineer } from "./agents/engineer.js";
import { RiskAssessor } from "./agents/risk-assessor.js";
import { SmellDetector } from "./agents/smell-detector.js";
import { Synthesis } from "./agents/synthesis.js";
import { BehaviorVerifier } from "./agents/verifier.js";
import { TestSurveyor } from "./agents/test-surveyor.js";
import type { AgentExecutionContext, AgentOutcomeCore, VibeFixAgent } from "./contract.js";
import { AGENT_DEFINITIONS } from "./definitions.js";

/** All 10 MVP agents, keyed by id. */
export function buildAgents(): Map<string, VibeFixAgent> {
  const agents: VibeFixAgent[] = [
    new Cartographer(),
    new TestSurveyor(),
    new SmellDetector(),
    new ArchitectureAuditor(),
    new RiskAssessor(),
    new Synthesis(),
    new HarnessBuilder(),
    new RefactoringEngineer(),
    new BehaviorVerifier(),
    new Docent(),
  ];
  const map = new Map<string, VibeFixAgent>();
  for (const agent of agents) map.set(agent.definition.agentId, agent);
  if (map.size !== AGENT_DEFINITIONS.length) {
    throw new Error(`agent registry mismatch: ${map.size} implementations vs ${AGENT_DEFINITIONS.length} definitions`);
  }
  return map;
}

/** Facts shared across agents within one run — computed once. */
interface RunFacts {
  snapshot: RepoSnapshot;
  importEdges: Awaited<ReturnType<RegexImportGraph["edges"]>>;
  metrics: FileMetrics;
}
const factsCache = new Map<string, Promise<RunFacts>>();

async function factsFor(repoPath: string): Promise<RunFacts> {
  let cached = factsCache.get(repoPath);
  if (!cached) {
    cached = (async () => {
      const fs = new NodeFsFacts();
      const snapshot = await fs.snapshot(repoPath);
      const graph = new RegexImportGraph(repoPath, snapshot.files);
      const importEdges = await graph.edges();
      const metrics = await computeMetrics(repoPath, snapshot.files);
      return { snapshot, importEdges, metrics };
    })();
    factsCache.set(repoPath, cached);
  }
  return cached;
}

/**
 * The composition-side executor: implements core's AgentExecutorPort with the
 * real agents. One instance per run, bound to that run's services (store,
 * events, meter, config). Facts are computed once per repo and shared.
 */
export class VibefixExecutor implements AgentExecutorPort {
  private readonly agents: Map<string, VibeFixAgent>;
  private readonly router: LlmRouter;

  constructor(
    private readonly services: RunServices,
    private readonly env: Record<string, string | undefined> = process.env,
    agents?: Map<string, VibeFixAgent>,
  ) {
    this.agents = agents ?? buildAgents();
    this.router = new LlmRouter(services.config.routing, env, (agentId, providerId, usage) => {
      services.meter.record(usage.totalTokens, agentId, providerId);
    });
  }

  definitions(): AgentDefinition[] {
    return AGENT_DEFINITIONS;
  }

  /**
   * Test-only hook: script the mock text provider for one agent. The product
   * never routes mocks (real-models-only defaults); tests use this to keep
   * the orchestrator suite deterministic and free.
   */
  registerMockScript(agentId: string, payload: unknown): this {
    this.router.mocks.mockText.when(agentId, payload);
    return this;
  }

  async execute(definition: AgentDefinition, input: AgentExecutionInput): Promise<AgentOutcomeCore> {
    const agent = this.agents.get(definition.agentId);
    if (!agent) {
      return { outcome: "failed", artifactIds: [], error: `no implementation for '${definition.agentId}'` };
    }

    // Resumability: if this producer already wrote everything it produces,
    // replay a pass without re-invoking the model.
    if (await this.services.store.hasArtifacts(definition.agentId, definition.produces)) {
      return { outcome: "passed", artifactIds: [] };
    }

    const facts = await factsFor(this.services.repoPath);
    const ctx: AgentExecutionContext = {
      def: definition,
      runState: input.runState,
      repoPath: this.services.repoPath,
      store: this.services.store,
      tools: {
        fs: new NodeFsFacts(),
        runner: new NodeTestRunner(),
        snapshot: facts.snapshot,
        importEdges: facts.importEdges,
        metrics: facts.metrics,
      },
      llm: this.safeText(definition),
      decision: this.safeDecision(definition),
      proposal: input.proposal,
      worktree: input.worktree,
      firewall: input.firewall,
      attempt: input.attempt,
      forbiddenZones: input.forbiddenZones,
      progress: async (step, detail) => {
        await this.services.events.append(input.runState.runId, "agent.progress", {
          agentId: definition.agentId,
          message: step,
          ...(detail ? { payload: { detail } } : {}),
        });
      },
    };
    return agent.execute(ctx);
  }

  /** Route or undefined — an unavailable provider degrades, never crashes. */
  private safeText(def: AgentDefinition) {
    if (def.capability !== "TextGeneration") return undefined;
    if (this.router.isUnscriptedMock(def.agentId)) return undefined; // zero-key demo mode
    try {
      return this.router.text(def.agentId);
    } catch {
      return undefined;
    }
  }

  private safeDecision(def: AgentDefinition) {
    if (def.capability !== "TypedDecision") return undefined;
    try {
      return this.router.decision(def.agentId);
    } catch {
      return undefined;
    }
  }
}

/** Executor factory for RunManager.open(). */
export function vibefixExecutorFactory(
  env: Record<string, string | undefined> = process.env,
): (services: RunServices) => VibefixExecutor {
  return (services) => new VibefixExecutor(services, env);
}

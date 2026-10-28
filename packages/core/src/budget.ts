import type { Budgets } from "@vibefix/schemas";

export interface BudgetSnapshot {
  tokensSpent: number;
  warnAt: number;
  hardStop: number;
  warned: boolean;
  callsMade: number;
  estimatedCostUsd: number;
}

/** Aggregates provider usage per run — total AND per agent (live in the UI). */
export class BudgetMeter {
  private tokensSpent = 0;
  private callsMade = 0;
  private estimatedCostUsd = 0;
  private warned = false;
  private agentLimitExceededBy: string | null = null;
  private readonly byAgent = new Map<string, number>();
  private readonly byProvider = new Map<string, number>();
  private readonly listeners = new Array<(snapshot: BudgetSnapshot) => void>();

  constructor(private readonly budgets: Budgets) {}

  record(tokens: number, agentId?: string, providerId?: string, costUsd = 0): BudgetSnapshot {
    this.tokensSpent += tokens;
    this.callsMade += 1;
    this.estimatedCostUsd = Number((this.estimatedCostUsd + costUsd).toFixed(6));
    if (agentId) {
      const nextAgentTokens = (this.byAgent.get(agentId) ?? 0) + tokens;
      this.byAgent.set(agentId, nextAgentTokens);
      if (this.budgets.agentMaxTokens !== undefined && nextAgentTokens >= this.budgets.agentMaxTokens) {
        this.agentLimitExceededBy = agentId;
      }
    }
    if (providerId) this.byProvider.set(providerId, (this.byProvider.get(providerId) ?? 0) + tokens);
    const snapshot = this.snapshot();
    if (!this.warned && snapshot.tokensSpent >= snapshot.warnAt) {
      this.warned = true;
      for (const l of this.listeners) l(snapshot);
    }
    return snapshot;
  }

  snapshot(): BudgetSnapshot {
    return {
      tokensSpent: this.tokensSpent,
      warnAt: Math.floor(this.budgets.runMaxTokens * this.budgets.warnFraction),
      hardStop: this.budgets.runMaxTokens,
      warned: this.warned,
      callsMade: this.callsMade,
      estimatedCostUsd: this.estimatedCostUsd,
    };
  }

  usage(): {
    total: number;
    byAgent: Record<string, number>;
    byProvider: Record<string, number>;
    callsMade?: number;
    estimatedCostUsd?: number;
  } {
    return {
      total: this.tokensSpent,
      byAgent: Object.fromEntries(this.byAgent),
      byProvider: Object.fromEntries(this.byProvider),
      callsMade: this.callsMade,
      estimatedCostUsd: this.estimatedCostUsd,
    };
  }

  get exceededReason(): string | null {
    if (this.tokensSpent >= this.budgets.runMaxTokens) return "token budget exhausted";
    if (this.agentLimitExceededBy) return `agent token budget exhausted (${this.agentLimitExceededBy})`;
    if (this.budgets.maxLlmCallsPerRun !== undefined && this.callsMade >= this.budgets.maxLlmCallsPerRun) {
      return "LLM call budget exhausted";
    }
    if (this.budgets.maxCostUsd !== undefined && this.estimatedCostUsd >= this.budgets.maxCostUsd) {
      return "estimated cost ceiling exhausted";
    }
    return null;
  }

  get exceeded(): boolean {
    return this.exceededReason !== null;
  }

  get tokens(): number {
    return this.tokensSpent;
  }

  get calls(): number {
    return this.callsMade;
  }

  get costUsd(): number {
    return this.estimatedCostUsd;
  }

  /** Fired once when crossing the warn threshold. */
  onWarn(listener: (snapshot: BudgetSnapshot) => void): void {
    this.listeners.push(listener);
  }
}

import type { Budgets } from "@vibefix/schemas";

export interface BudgetSnapshot {
  tokensSpent: number;
  warnAt: number;
  hardStop: number;
  warned: boolean;
}

/** Aggregates provider usage per run — total AND per agent (live in the UI). */
export class BudgetMeter {
  private tokensSpent = 0;
  private warned = false;
  private readonly byAgent = new Map<string, number>();
  private readonly byProvider = new Map<string, number>();
  private readonly listeners = new Array<(snapshot: BudgetSnapshot) => void>();

  constructor(private readonly budgets: Budgets) {}

  record(tokens: number, agentId?: string, providerId?: string): BudgetSnapshot {
    this.tokensSpent += tokens;
    if (agentId) this.byAgent.set(agentId, (this.byAgent.get(agentId) ?? 0) + tokens);
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
    };
  }

  usage(): { total: number; byAgent: Record<string, number>; byProvider: Record<string, number> } {
    return {
      total: this.tokensSpent,
      byAgent: Object.fromEntries(this.byAgent),
      byProvider: Object.fromEntries(this.byProvider),
    };
  }

  get exceeded(): boolean {
    return this.tokensSpent >= this.budgets.runMaxTokens;
  }

  get tokens(): number {
    return this.tokensSpent;
  }

  /** Fired once when crossing the warn threshold. */
  onWarn(listener: (snapshot: BudgetSnapshot) => void): void {
    this.listeners.push(listener);
  }
}

import type { Budgets } from "@vibefix/schemas";

export interface BudgetSnapshot {
  tokensSpent: number;
  warnAt: number;
  hardStop: number;
  warned: boolean;
}

/** Aggregates provider usage per run; runtime reads state for UI + gates. */
export class BudgetMeter {
  private tokensSpent = 0;
  private warned = false;
  private readonly listeners = new Array<(snapshot: BudgetSnapshot) => void>();

  constructor(private readonly budgets: Budgets) {}

  record(tokens: number): BudgetSnapshot {
    this.tokensSpent += tokens;
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

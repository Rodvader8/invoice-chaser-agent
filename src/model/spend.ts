import type { Store } from "../storage/types.js";

export class SpendCapError extends Error {}

export interface SpendLimits {
  /** Most this process may spend on model calls. */
  runCapUsd: number;
  /** Most the project may spend in total, across runs (persisted in the store). */
  projectCapUsd: number;
  /** Refuse to call if the account balance would fall below this. Needs a balance source. */
  accountFloorUsd?: number;
}

/**
 * Hard spend limits, checked before every call against a worst-case estimate. A call that fails
 * after being sent is charged at the estimate, because it may have been billed.
 */
export class SpendGuard {
  private runSpentUsd = 0;
  private reservedUsd = 0;

  constructor(
    private readonly limits: SpendLimits,
    private readonly store: Store,
    private readonly balanceUsd?: () => Promise<number>,
  ) {
    if (!(limits.runCapUsd > 0) || !(limits.projectCapUsd > 0)) {
      throw new SpendCapError("spend caps must be positive numbers");
    }
  }

  get spentThisRunUsd(): number {
    return this.runSpentUsd;
  }

  async reserve(estimateUsd: number): Promise<void> {
    if (!(estimateUsd >= 0) || !Number.isFinite(estimateUsd)) {
      throw new SpendCapError("cost estimate must be a finite number");
    }
    const run = this.runSpentUsd + this.reservedUsd + estimateUsd;
    if (run > this.limits.runCapUsd) {
      throw new SpendCapError(`run cap $${this.limits.runCapUsd} would be exceeded`);
    }
    const project = (await this.store.totalSpendUsd()) + this.reservedUsd + estimateUsd;
    if (project > this.limits.projectCapUsd) {
      throw new SpendCapError(`project cap $${this.limits.projectCapUsd} would be exceeded`);
    }
    if (this.limits.accountFloorUsd !== undefined) {
      if (!this.balanceUsd) throw new SpendCapError("account floor set but no balance source");
      const balance = await this.balanceUsd();
      if (balance - estimateUsd < this.limits.accountFloorUsd) {
        throw new SpendCapError(`account balance would fall below $${this.limits.accountFloorUsd}`);
      }
    }
    this.reservedUsd += estimateUsd;
  }

  async settle(
    estimateUsd: number,
    actualUsd: number,
    model: string,
    purpose: string,
  ): Promise<void> {
    this.reservedUsd = Math.max(0, this.reservedUsd - estimateUsd);
    this.runSpentUsd += actualUsd;
    await this.store.addSpend(actualUsd, model, purpose);
  }
}

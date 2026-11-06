import type { Money } from "../../domain/money/money";
import { WalletNotFoundError } from "../errors";
import type { AppLogger } from "../ports/app-logger.port";
import type { LedgerRepository } from "../ports/ledger.repository";
import type { WageringMetrics } from "../ports/wagering-metrics.port";

export interface WalletReconciliation {
  readonly walletId: string;
  readonly storedBalance: Money;
  readonly calculatedBalance: Money;
  /** storedBalance - calculatedBalance. */
  readonly difference: Money;
  readonly consistent: boolean;
  readonly checkedEntries: number;
}

/**
 * Compares the stored balance with the balance rebuilt from the ledger and checks the entry chain. A divergence is
 * logged, counted and reported, never corrected.
 */
export class ReconcileWallet {
  constructor(
    private readonly ledger: LedgerRepository,
    private readonly metrics: WageringMetrics,
    private readonly logger: AppLogger,
  ) {}

  async execute(walletId: string): Promise<WalletReconciliation> {
    const snapshot = await this.ledger.reconciliationSnapshot(walletId);
    if (!snapshot) throw new WalletNotFoundError(walletId, "resource");
    const difference = snapshot.storedBalance.subtract(snapshot.calculatedBalance);
    const consistent = difference.isZero() && snapshot.chainBreaks === 0;
    if (!consistent) {
      this.metrics.reconciliationDivergence();
      this.logger.warn("wallet balance diverges from its ledger", {
        event: "reconciliation.divergence",
        walletId,
        chainBreaks: snapshot.chainBreaks,
      });
    }
    return {
      walletId,
      storedBalance: snapshot.storedBalance,
      calculatedBalance: snapshot.calculatedBalance,
      difference,
      consistent,
      checkedEntries: snapshot.checkedEntries,
    };
  }
}

import type { Money } from "../../domain/money/money";
import type { WalletLedgerEntry } from "../../domain/wallet/wallet-ledger-entry";

export interface LedgerPageQuery {
  readonly walletId: string;
  /** Only entries with a wallet version strictly below this one (the previous page's last version). */
  readonly beforeVersion?: number;
  readonly limit: number;
}

/** The stored balance next to the balance rebuilt from the ledger, read in one consistent snapshot. */
export interface LedgerReconciliationSnapshot {
  readonly storedBalance: Money;
  readonly calculatedBalance: Money;
  readonly checkedEntries: number;
  /** Entries whose balanceBefore differs from the previous entry's balanceAfter (or from zero for the first). */
  readonly chainBreaks: number;
}

export interface LedgerRepository {
  /** Newest first (descending wallet version). */
  listByWallet(query: LedgerPageQuery): Promise<WalletLedgerEntry[]>;
  reconciliationSnapshot(walletId: string): Promise<LedgerReconciliationSnapshot | undefined>;
  /** The write happens when the unit of work commits. */
  add(entry: WalletLedgerEntry): void;
}

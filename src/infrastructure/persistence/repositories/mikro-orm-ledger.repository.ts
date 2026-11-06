import type { EntityManager } from "@mikro-orm/postgresql";
import type {
  LedgerPageQuery,
  LedgerReconciliationSnapshot,
  LedgerRepository,
} from "../../../application/ports/ledger.repository";
import { Money } from "../../../domain/money/money";
import type { WalletLedgerEntry } from "../../../domain/wallet/wallet-ledger-entry";
import { LedgerEntryMapper } from "../mappers/ledger-entry.mapper";
import { withDatabaseErrors } from "../pg-error-classifier";
import { LedgerEntryRecord } from "../records/ledger-entry.record";
import { WagerTransactionRecord } from "../records/wager-transaction.record";
import { WalletRecord } from "../records/wallet.record";

/**
 * One statement, so stored balance, ledger sum and chain check come from one snapshot. Money stays `numeric` in SQL
 * and travels as text; counts are plain integers.
 */
const RECONCILIATION_SQL = `
WITH ledger AS (
  SELECT direction, amount, balance_before,
         COALESCE(lag(balance_after) OVER (ORDER BY wallet_version), 0) AS expected_before
  FROM wallet_ledger_entries
  WHERE wallet_id = ?
)
SELECT w.balance::text AS stored_balance,
       w.currency AS currency,
       (SELECT COALESCE(SUM(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END), 0)::numeric(20,2)::text
          FROM ledger) AS calculated_balance,
       (SELECT COUNT(*) FROM ledger)::integer AS checked_entries,
       (SELECT COUNT(*) FROM ledger WHERE balance_before <> expected_before)::integer AS chain_breaks
FROM wallets w
WHERE w.id = ?`;

interface ReconciliationRow {
  readonly stored_balance: string;
  readonly currency: string;
  readonly calculated_balance: string;
  readonly checked_entries: number;
  readonly chain_breaks: number;
}

export class MikroOrmLedgerRepository implements LedgerRepository {
  constructor(private readonly em: EntityManager) {}

  async listByWallet({ walletId, beforeVersion, limit }: LedgerPageQuery): Promise<WalletLedgerEntry[]> {
    const records = await withDatabaseErrors(() =>
      this.em.find(
        LedgerEntryRecord,
        { wallet: walletId, ...(beforeVersion === undefined ? {} : { walletVersion: { $lt: beforeVersion } }) },
        { orderBy: { walletVersion: "desc" }, limit },
      ),
    );
    return records.map((record) => LedgerEntryMapper.toDomain(record));
  }

  async reconciliationSnapshot(walletId: string): Promise<LedgerReconciliationSnapshot | undefined> {
    const rows = await withDatabaseErrors(() =>
      this.em.execute<ReconciliationRow[]>(RECONCILIATION_SQL, [walletId, walletId]),
    );
    const row = rows[0];
    if (!row) return undefined;
    return {
      storedBalance: Money.rehydrate({ amount: row.stored_balance, currency: row.currency }),
      calculatedBalance: Money.rehydrate({ amount: row.calculated_balance, currency: row.currency }),
      checkedEntries: row.checked_entries,
      chainBreaks: row.chain_breaks,
    };
  }

  add(entry: WalletLedgerEntry): void {
    const parents = {
      wallet: this.em.getReference(WalletRecord, entry.walletId),
      transaction: this.em.getReference(WagerTransactionRecord, entry.transactionId),
    };
    this.em.persist(LedgerEntryMapper.toRecord(entry, parents));
  }
}

import { Money } from "../../../domain/money/money";
import type { LedgerDirection } from "../../../domain/wallet/ledger-direction";
import { WalletLedgerEntry } from "../../../domain/wallet/wallet-ledger-entry";
import { LedgerEntryRecord } from "../records/ledger-entry.record";
import type { WagerTransactionRecord } from "../records/wager-transaction.record";
import type { WalletRecord } from "../records/wallet.record";

export interface LedgerEntryParents {
  readonly wallet: WalletRecord;
  readonly transaction: WagerTransactionRecord;
}

export const LedgerEntryMapper = {
  toDomain(record: LedgerEntryRecord): WalletLedgerEntry {
    const money = (amount: string) => Money.rehydrate({ amount, currency: record.currency });
    return WalletLedgerEntry.rehydrate({
      id: record.id,
      walletId: record.wallet.id,
      transactionId: record.transaction.id,
      walletVersion: record.walletVersion,
      direction: record.direction as LedgerDirection,
      money: money(record.amount),
      balanceBefore: money(record.balanceBefore),
      balanceAfter: money(record.balanceAfter),
      createdAt: record.createdAt,
    });
  },

  /** `parents` are the managed (or reference) records the entry belongs to. */
  toRecord(entry: WalletLedgerEntry, parents: LedgerEntryParents): LedgerEntryRecord {
    return Object.assign(new LedgerEntryRecord(), {
      id: entry.id,
      ...parents,
      walletVersion: entry.walletVersion,
      direction: entry.direction,
      amount: entry.money.amount,
      currency: entry.money.currency,
      balanceBefore: entry.balanceBefore.amount,
      balanceAfter: entry.balanceAfter.amount,
      createdAt: entry.createdAt,
    });
  },
};

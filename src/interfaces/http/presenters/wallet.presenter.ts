import type { LedgerPage } from "../../../application/wallets/list-wallet-ledger";
import type { WalletReconciliation } from "../../../application/wallets/reconcile-wallet";
import type { MoneyProps } from "../../../domain/money/money-props";
import type { Wallet } from "../../../domain/wallet/wallet";
import type { WalletLedgerEntry } from "../../../domain/wallet/wallet-ledger-entry";
import { LedgerCursor } from "../ledger-cursor";

export interface WalletView {
  readonly id: string;
  readonly playerId: string;
  readonly balance: MoneyProps;
  readonly version: number;
}

export function walletView(wallet: Wallet): WalletView {
  return { id: wallet.id, playerId: wallet.playerId, balance: wallet.balance.toJSON(), version: wallet.version };
}

export function ledgerPageView(page: LedgerPage) {
  const last = page.entries.at(-1);
  return {
    items: page.entries.map(ledgerEntryView),
    nextCursor: page.hasMore && last ? LedgerCursor.encode(last.walletVersion) : null,
  };
}

function ledgerEntryView(entry: WalletLedgerEntry) {
  return {
    id: entry.id,
    transactionId: entry.transactionId,
    direction: entry.direction,
    money: entry.money.toJSON(),
    balanceBefore: entry.balanceBefore.toJSON(),
    balanceAfter: entry.balanceAfter.toJSON(),
    walletVersion: entry.walletVersion,
    createdAt: entry.createdAt.toISOString(),
  };
}

export function reconciliationView(reconciliation: WalletReconciliation) {
  return {
    walletId: reconciliation.walletId,
    storedBalance: reconciliation.storedBalance.toJSON(),
    calculatedBalance: reconciliation.calculatedBalance.toJSON(),
    difference: reconciliation.difference.toJSON(),
    consistent: reconciliation.consistent,
    checkedEntries: reconciliation.checkedEntries,
  };
}

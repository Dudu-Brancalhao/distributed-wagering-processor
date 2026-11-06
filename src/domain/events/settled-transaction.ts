import { InvalidTransactionStateError } from "../shared/invalid-transaction-state.error";
import type { WagerTransaction, WalletObservation } from "../wagering/wager-transaction";
import type { WagerTransactionStatus } from "../wagering/wager-transaction-status";

/** Reads the wallet observation of a transaction that must already be in `expected` status. */
export function observationOf(transaction: WagerTransaction, expected: WagerTransactionStatus): WalletObservation {
  const { observedBalance, observedWalletVersion } = transaction;
  if (transaction.status !== expected || !observedBalance || observedWalletVersion === undefined) {
    throw new InvalidTransactionStateError(
      `Transaction ${transaction.id} is ${transaction.status}, expected ${expected} with an observed balance`,
    );
  }
  return { balance: observedBalance, walletVersion: observedWalletVersion };
}

import type { EventContext, IntegrationEvent } from "../../domain/events/integration-event";
import { WagerTransactionPendingReference } from "../../domain/events/wager-transaction-pending-reference";
import { WagerTransactionProcessed } from "../../domain/events/wager-transaction-processed";
import { WagerTransactionRejected } from "../../domain/events/wager-transaction-rejected";
import { WalletBalanceChanged } from "../../domain/events/wallet-balance-changed";
import { OutboxMessage } from "../../domain/messaging/outbox-message";
import type { WagerTransaction } from "../../domain/wagering/wager-transaction";
import { WagerTransactionStatus } from "../../domain/wagering/wager-transaction-status";
import type { Wallet } from "../../domain/wallet/wallet";
import type { WalletLedgerEntry } from "../../domain/wallet/wallet-ledger-entry";

export interface SettledOutcome {
  readonly transaction: WagerTransaction;
  readonly wallet: Wallet;
  /** The ledger entry, when the balance moved. */
  readonly entry?: WalletLedgerEntry;
}

/**
 * The outbox messages of an outcome (spec 3.6): applied gives Processed plus BalanceChanged when the balance moved;
 * rejected gives Rejected; entering PENDING_REFERENCE gives PendingReference; FAILED gives none (OQ-15).
 */
export function outboxMessagesFor(outcome: SettledOutcome, nextContext: () => EventContext): OutboxMessage[] {
  return eventsFor(outcome, nextContext).map((event) => OutboxMessage.enqueue(event));
}

function eventsFor(
  { transaction, wallet, entry }: SettledOutcome,
  nextContext: () => EventContext,
): IntegrationEvent<unknown>[] {
  switch (transaction.status) {
    case WagerTransactionStatus.Processed:
      return [
        WagerTransactionProcessed.from(transaction, nextContext()),
        ...(entry ? [WalletBalanceChanged.from(wallet, entry, nextContext())] : []),
      ];
    case WagerTransactionStatus.Rejected:
      return [WagerTransactionRejected.from(transaction, nextContext())];
    case WagerTransactionStatus.PendingReference:
      return [WagerTransactionPendingReference.from(transaction, nextContext())];
    case WagerTransactionStatus.Pending:
    case WagerTransactionStatus.Failed:
      return [];
  }
}

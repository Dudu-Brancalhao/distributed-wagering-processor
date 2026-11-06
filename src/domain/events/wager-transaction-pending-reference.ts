import { InvalidTransactionStateError } from "../shared/invalid-transaction-state.error";
import type { WagerTransaction } from "../wagering/wager-transaction";
import { WagerTransactionStatus } from "../wagering/wager-transaction-status";
import { type EventContext, eventProps, IntegrationEvent } from "./integration-event";

export interface WagerTransactionPendingReferenceData {
  readonly transactionId: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly walletId: string;
  readonly kind: string;
  readonly referenceExternalTransactionId: string;
  readonly attempts: number;
  readonly nextAttemptAt: string;
}

/** A transaction that waits for its referenced transaction to arrive. */
export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = "WagerTransactionPendingReference";
  readonly version = 1;

  static from(transaction: WagerTransaction, context: EventContext): WagerTransactionPendingReference {
    const { referenceExternalTransactionId, nextAttemptAt } = transaction;
    if (
      transaction.status !== WagerTransactionStatus.PendingReference ||
      referenceExternalTransactionId === undefined ||
      nextAttemptAt === undefined
    ) {
      throw new InvalidTransactionStateError(`Transaction ${transaction.id} is not waiting for a reference`);
    }
    return new WagerTransactionPendingReference(
      eventProps(context, transaction.id, {
        transactionId: transaction.id,
        providerId: transaction.providerId,
        externalTransactionId: transaction.externalTransactionId,
        walletId: transaction.walletId,
        kind: transaction.kind,
        referenceExternalTransactionId,
        attempts: transaction.attempts,
        nextAttemptAt: nextAttemptAt.toISOString(),
      }),
    );
  }
}

import type { MoneyProps } from "../money/money-props";
import { InvalidTransactionStateError } from "../shared/invalid-transaction-state.error";
import type { WagerTransaction } from "../wagering/wager-transaction";
import { WagerTransactionStatus } from "../wagering/wager-transaction-status";
import { type EventContext, eventProps, IntegrationEvent } from "./integration-event";
import { observationOf } from "./settled-transaction";

export interface WagerTransactionRejectedData {
  readonly transactionId: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly walletId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: string;
  readonly money: MoneyProps;
  readonly referenceExternalTransactionId?: string;
  readonly failureCode: string;
  readonly balance: MoneyProps;
}

/** A transaction rejected by a business rule. */
export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = "WagerTransactionRejected";
  readonly version = 1;

  static from(transaction: WagerTransaction, context: EventContext): WagerTransactionRejected {
    const observation = observationOf(transaction, WagerTransactionStatus.Rejected);
    if (!transaction.failureCode) {
      throw new InvalidTransactionStateError(`Rejected transaction ${transaction.id} has no failure code`);
    }
    return new WagerTransactionRejected(
      eventProps(context, transaction.id, {
        transactionId: transaction.id,
        providerId: transaction.providerId,
        externalTransactionId: transaction.externalTransactionId,
        walletId: transaction.walletId,
        roundId: transaction.roundId,
        gameId: transaction.gameId,
        kind: transaction.kind,
        money: transaction.money.toJSON(),
        ...(transaction.referenceExternalTransactionId === undefined
          ? {}
          : { referenceExternalTransactionId: transaction.referenceExternalTransactionId }),
        failureCode: transaction.failureCode,
        balance: observation.balance.toJSON(),
      }),
    );
  }
}

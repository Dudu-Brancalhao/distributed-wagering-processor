import type { MoneyProps } from "../money/money-props";
import type { WagerTransaction } from "../wagering/wager-transaction";
import { WagerTransactionStatus } from "../wagering/wager-transaction-status";
import { type EventContext, eventProps, IntegrationEvent } from "./integration-event";
import { observationOf } from "./settled-transaction";

export interface WagerTransactionProcessedData {
  readonly transactionId: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly walletId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: string;
  readonly money: MoneyProps;
  readonly referenceTransactionId?: string;
  readonly balance: MoneyProps;
  readonly walletVersion: number;
  readonly processedAt: string;
}

/** Any applied transaction, LOSS and OPENING included. */
export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = "WagerTransactionProcessed";
  readonly version = 1;

  static from(transaction: WagerTransaction, context: EventContext): WagerTransactionProcessed {
    const observation = observationOf(transaction, WagerTransactionStatus.Processed);
    return new WagerTransactionProcessed(
      eventProps(context, transaction.id, {
        transactionId: transaction.id,
        providerId: transaction.providerId,
        externalTransactionId: transaction.externalTransactionId,
        walletId: transaction.walletId,
        roundId: transaction.roundId,
        gameId: transaction.gameId,
        kind: transaction.kind,
        money: transaction.money.toJSON(),
        ...(transaction.referenceTransactionId === undefined
          ? {}
          : { referenceTransactionId: transaction.referenceTransactionId }),
        balance: observation.balance.toJSON(),
        walletVersion: observation.walletVersion,
        processedAt: (transaction.processedAt ?? context.occurredAt).toISOString(),
      }),
    );
  }
}

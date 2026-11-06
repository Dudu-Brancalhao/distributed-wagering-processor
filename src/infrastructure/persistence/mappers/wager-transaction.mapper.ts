import { Money } from "../../../domain/money/money";
import type { FailureCode } from "../../../domain/wagering/failure-code";
import { WagerTransaction } from "../../../domain/wagering/wager-transaction";
import type { WagerTransactionKind } from "../../../domain/wagering/wager-transaction-kind";
import type { WagerTransactionStatus } from "../../../domain/wagering/wager-transaction-status";
import { WagerTransactionRecord } from "../records/wager-transaction.record";
import type { WalletRecord } from "../records/wallet.record";

export const WagerTransactionMapper = {
  toDomain(record: WagerTransactionRecord): WagerTransaction {
    return WagerTransaction.rehydrate({
      id: record.id,
      providerId: record.providerId,
      externalTransactionId: record.externalTransactionId,
      idempotencyKey: record.idempotencyKey,
      payloadHash: record.payloadHash,
      correlationId: record.correlationId,
      walletId: record.wallet.id,
      playerId: record.playerId,
      roundId: record.roundId,
      gameId: record.gameId,
      kind: record.kind as WagerTransactionKind,
      money: Money.rehydrate({ amount: record.amount, currency: record.currency }),
      referenceExternalTransactionId: record.referenceExternalTransactionId ?? undefined,
      referenceTransactionId: record.referenceTransactionId ?? undefined,
      status: record.status as WagerTransactionStatus,
      failureCode: (record.failureCode ?? undefined) as FailureCode | undefined,
      observedBalance: observedBalanceOf(record),
      observedWalletVersion: record.observedWalletVersion ?? undefined,
      attempts: record.attempts,
      nextAttemptAt: record.nextAttemptAt ?? undefined,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      processedAt: record.processedAt ?? undefined,
    });
  },

  /** `wallet` is the managed (or reference) record of the transaction's wallet. */
  toRecord(transaction: WagerTransaction, wallet: WalletRecord): WagerTransactionRecord {
    return Object.assign(new WagerTransactionRecord(), {
      id: transaction.id,
      providerId: transaction.providerId,
      externalTransactionId: transaction.externalTransactionId,
      idempotencyKey: transaction.idempotencyKey,
      payloadHash: transaction.payloadHash,
      correlationId: transaction.correlationId,
      wallet,
      playerId: transaction.playerId,
      roundId: transaction.roundId,
      gameId: transaction.gameId,
      kind: transaction.kind,
      amount: transaction.money.amount,
      currency: transaction.money.currency,
      referenceExternalTransactionId: transaction.referenceExternalTransactionId ?? null,
      createdAt: transaction.createdAt,
      ...WagerTransactionMapper.mutableFields(transaction),
    });
  },

  /** The columns a status transition may update; the request columns are immutable (guard trigger). */
  mutableFields(transaction: WagerTransaction) {
    return {
      referenceTransactionId: transaction.referenceTransactionId ?? null,
      status: transaction.status,
      failureCode: transaction.failureCode ?? null,
      observedBalance: transaction.observedBalance?.amount ?? null,
      observedCurrency: transaction.observedBalance?.currency ?? null,
      observedWalletVersion: transaction.observedWalletVersion ?? null,
      attempts: transaction.attempts,
      nextAttemptAt: transaction.nextAttemptAt ?? null,
      updatedAt: transaction.updatedAt,
      processedAt: transaction.processedAt ?? null,
    };
  },
};

function observedBalanceOf(record: WagerTransactionRecord): Money | undefined {
  if (record.observedBalance === null || record.observedCurrency === null) return undefined;
  return Money.rehydrate({ amount: record.observedBalance, currency: record.observedCurrency });
}

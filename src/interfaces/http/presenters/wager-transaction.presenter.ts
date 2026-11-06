import { HttpStatus } from "@nestjs/common";
import type { SubmitWagerTransactionResult } from "../../../application/wagering/submit-wager-transaction.command";
import { FailureCode } from "../../../domain/wagering/failure-code";
import type { WagerTransaction } from "../../../domain/wagering/wager-transaction";
import { WagerTransactionStatus } from "../../../domain/wagering/wager-transaction-status";

/** The status code is a pure function of the stored status, so a replay gets exactly the first response's code. */
const STATUS_CODES: Readonly<Record<WagerTransactionStatus, number>> = {
  [WagerTransactionStatus.Processed]: HttpStatus.CREATED,
  [WagerTransactionStatus.PendingReference]: HttpStatus.ACCEPTED,
  [WagerTransactionStatus.Pending]: HttpStatus.ACCEPTED,
  [WagerTransactionStatus.Rejected]: HttpStatus.UNPROCESSABLE_ENTITY,
  [WagerTransactionStatus.Failed]: HttpStatus.UNPROCESSABLE_ENTITY,
};

const UNSUCCESSFUL: ReadonlySet<WagerTransactionStatus> = new Set([
  WagerTransactionStatus.Rejected,
  WagerTransactionStatus.Failed,
]);

export function submissionStatusCode(transaction: WagerTransaction): number {
  return STATUS_CODES[transaction.status];
}

/** `{ transactionId, status, balance, idempotentReplay, failureCode?, code? }`; `code` repeats the failure on 422. */
export function submissionView({ transaction, idempotentReplay }: SubmitWagerTransactionResult) {
  const outcome = outcomeFields(transaction);
  return {
    transactionId: transaction.id,
    status: transaction.status,
    ...outcome.balance,
    idempotentReplay,
    ...outcome.failure,
    ...(UNSUCCESSFUL.has(transaction.status) && transaction.failureCode ? { code: transaction.failureCode } : {}),
  };
}

/** The full stored transaction, as returned by the query endpoints. */
export function transactionView(transaction: WagerTransaction) {
  const outcome = outcomeFields(transaction);
  return {
    transactionId: transaction.id,
    status: transaction.status,
    ...outcome.balance,
    ...outcome.failure,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    roundId: transaction.roundId,
    gameId: transaction.gameId,
    kind: transaction.kind,
    money: transaction.money.toJSON(),
    ...optional("referenceExternalTransactionId", transaction.referenceExternalTransactionId),
    ...optional("referenceTransactionId", transaction.referenceTransactionId),
    createdAt: transaction.createdAt.toISOString(),
    ...optional("processedAt", transaction.processedAt?.toISOString()),
  };
}

/** The observed balance is withheld for PLAYER_WALLET_MISMATCH: it belongs to another player's wallet. */
function outcomeFields(transaction: WagerTransaction) {
  const hidesBalance = transaction.failureCode === FailureCode.PlayerWalletMismatch;
  return {
    balance: hidesBalance ? {} : optional("balance", transaction.observedBalance?.toJSON()),
    failure: optional("failureCode", transaction.failureCode),
  };
}

function optional<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };
}

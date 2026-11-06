import { FailureCode } from "./failure-code";
import type { WagerTransaction } from "./wager-transaction";
import { WagerTransactionKind } from "./wager-transaction-kind";
import { WagerTransactionStatus } from "./wager-transaction-status";

export type ReferenceVerdict =
  | { readonly kind: "accept" }
  | { readonly kind: "await" }
  | { readonly kind: "reject"; readonly code: FailureCode };

const ALLOWED_REFERENCE_KINDS: Readonly<Partial<Record<WagerTransactionKind, readonly WagerTransactionKind[]>>> = {
  [WagerTransactionKind.Refund]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Rollback]: [WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Refund],
  [WagerTransactionKind.Win]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Loss]: [WagerTransactionKind.Bet],
};

/**
 * Decides whether a resolved reference can be used, checking in a fixed order (spec 3.8 step 9):
 * kind, scope, status, amount (reversals), single reversal (reversals).
 */
export const ReferencePolicy = {
  evaluate(transaction: WagerTransaction, reference: WagerTransaction, alreadyReversed: boolean): ReferenceVerdict {
    if (!ALLOWED_REFERENCE_KINDS[transaction.kind]?.includes(reference.kind)) {
      return reject(FailureCode.ReferenceKindNotAllowed);
    }
    if (!sameScope(transaction, reference)) {
      return reject(FailureCode.ReferenceScopeMismatch);
    }
    if (!reference.isTerminal()) {
      return { kind: "await" };
    }
    if (reference.status !== WagerTransactionStatus.Processed) {
      return reject(FailureCode.ReferenceNotProcessed);
    }
    if (transaction.isReversal() && !transaction.money.equals(reference.money)) {
      return reject(FailureCode.ReversalAmountMismatch);
    }
    if (transaction.isReversal() && alreadyReversed) {
      return reject(FailureCode.ReferenceAlreadyReversed);
    }
    return { kind: "accept" };
  },
};

function reject(code: FailureCode): ReferenceVerdict {
  return { kind: "reject", code };
}

function sameScope(transaction: WagerTransaction, reference: WagerTransaction): boolean {
  return (
    transaction.providerId === reference.providerId &&
    transaction.playerId === reference.playerId &&
    transaction.walletId === reference.walletId &&
    transaction.money.currency === reference.money.currency &&
    transaction.roundId === reference.roundId
  );
}

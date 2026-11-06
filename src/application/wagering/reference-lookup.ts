import type { WagerTransaction } from "../../domain/wagering/wager-transaction";
import type { WagerTransactionRepository } from "../ports/wager-transaction.repository";

/** What the processor needs to know about a transaction's reference (spec 3.8 step 9). */
export interface ResolvedReference {
  /** The referenced transaction, or undefined when it does not exist (yet) or none is named. */
  readonly reference?: WagerTransaction;
  /** Whether the reference already has a PROCESSED reversal. */
  readonly referenceAlreadyReversed: boolean;
}

/** Resolves the reference by `(providerId, referenceExternalTransactionId)`. Shared by submit and retry. */
export async function lookUpReference(
  transactions: WagerTransactionRepository,
  transaction: WagerTransaction,
): Promise<ResolvedReference> {
  if (transaction.referenceExternalTransactionId === undefined) {
    return { referenceAlreadyReversed: false };
  }
  const reference = await transactions.findByExternalId(
    transaction.providerId,
    transaction.referenceExternalTransactionId,
  );
  if (!reference || !transaction.isReversal()) {
    return { reference, referenceAlreadyReversed: false };
  }
  return { reference, referenceAlreadyReversed: await transactions.hasProcessedReversal(reference.id) };
}

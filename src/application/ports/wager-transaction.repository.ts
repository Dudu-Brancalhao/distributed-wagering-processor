import type { WagerTransaction } from "../../domain/wagering/wager-transaction";

/** A PENDING_REFERENCE transaction whose next retry is due, read without a lock. */
export interface PendingReferenceCandidate {
  readonly transactionId: string;
  readonly walletId: string;
}

export interface WagerTransactionRepository {
  findById(transactionId: string): Promise<WagerTransaction | undefined>;
  findByIdempotencyKey(providerId: string, idempotencyKey: string): Promise<WagerTransaction | undefined>;
  findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined>;
  /** Whether a PROCESSED REFUND or ROLLBACK already references the transaction. */
  hasProcessedReversal(referenceTransactionId: string): Promise<boolean>;
  /** Due PENDING_REFERENCE transactions, earliest `nextAttemptAt` first (spec 3.16 step 1). */
  findDuePendingReferences(at: Date, limit: number): Promise<PendingReferenceCandidate[]>;
  /** The write happens when the unit of work commits. */
  add(transaction: WagerTransaction): void;
  /** Writes the status columns of a transaction read in this unit of work; the write happens at commit. */
  updateStatus(transaction: WagerTransaction): void;
}

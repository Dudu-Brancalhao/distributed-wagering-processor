import type { WagerTransaction } from "../../domain/wagering/wager-transaction";

export interface WagerTransactionRepository {
  findById(transactionId: string): Promise<WagerTransaction | undefined>;
  findByIdempotencyKey(providerId: string, idempotencyKey: string): Promise<WagerTransaction | undefined>;
  findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined>;
  /** Whether a PROCESSED REFUND or ROLLBACK already references the transaction. */
  hasProcessedReversal(referenceTransactionId: string): Promise<boolean>;
  /** The write happens when the unit of work commits. */
  add(transaction: WagerTransaction): void;
}

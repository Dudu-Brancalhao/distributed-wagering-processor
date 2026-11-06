export type TransactionSource = "http" | "sqs" | "pending_reference";
export type DuplicateType = "inbox" | "idempotent_replay";
export type RetryComponent = "sqs" | "outbox" | "pending_reference" | "unique_race";
export type LockConflictReason = "timeout" | "unique_race";
export type ProcessingOutcomeLabel = "processed" | "rejected" | "pending_reference" | "replay" | "conflict" | "error";

export interface TransactionLabels {
  readonly kind: string;
  readonly status: string;
  readonly source: TransactionSource;
}

export interface ProcessingLabels {
  readonly kind: string;
  readonly source: TransactionSource;
  readonly outcome: ProcessingOutcomeLabel;
}

/** Business metrics of spec 3.18. Lock contention is derived by the adapter from the observed wait. */
export interface WageringMetrics {
  transactionRecorded(labels: TransactionLabels): void;
  duplicateDetected(type: DuplicateType): void;
  idempotencyConflict(source: TransactionSource, code: string): void;
  retried(component: RetryComponent): void;
  walletLockWaited(seconds: number): void;
  lockConflict(reason: LockConflictReason): void;
  processingObserved(labels: ProcessingLabels, seconds: number): void;
  reconciliationDivergence(): void;
  /** Age of the oldest unpublished outbox message, sampled by the publisher (0 when nothing is waiting). */
  outboxLagObserved(seconds: number): void;
  deadLettered(reason: string): void;
}

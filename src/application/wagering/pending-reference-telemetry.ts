import { DomainError } from "../../domain/shared/domain-error";
import type { WagerTransaction } from "../../domain/wagering/wager-transaction";
import { WagerTransactionStatus } from "../../domain/wagering/wager-transaction-status";
import { ApplicationError, TransientInfrastructureError } from "../errors";
import type { AppLogger, LogFields } from "../ports/app-logger.port";
import type { PendingReferenceCandidate } from "../ports/wager-transaction.repository";
import type { ProcessingOutcomeLabel, WageringMetrics } from "../ports/wagering-metrics.port";

const SOURCE = "pending_reference";
const MS_PER_SECOND = 1000;

/** Logs and metrics of the pending-reference retrier, emitted once a retry's outcome is final (after the commit). */
export class PendingReferenceTelemetry {
  constructor(
    private readonly logger: AppLogger,
    private readonly metrics: WageringMetrics,
  ) {}

  /** `transaction` is undefined when another instance had already handled the candidate. */
  retried(candidate: PendingReferenceCandidate, transaction: WagerTransaction | undefined, startedAt: number): void {
    if (!transaction) {
      this.logger.debug("pending reference already handled", { event: "pending_reference.skipped", ...candidate });
      return;
    }
    const fields = fieldsOf(transaction);
    if (transaction.status === WagerTransactionStatus.PendingReference) {
      this.metrics.retried(SOURCE);
      this.logger.debug("reference still missing, retry scheduled", {
        event: "pending_reference.retry_scheduled",
        attempts: transaction.attempts,
        ...fields,
      });
      this.observe(transaction.kind, "pending_reference", startedAt);
      return;
    }
    this.metrics.transactionRecorded({ kind: transaction.kind, status: transaction.status, source: SOURCE });
    this.logger.info("pending reference transaction settled", {
      event: `transaction.${transaction.status.toLowerCase()}`,
      failureCode: transaction.failureCode,
      attempts: transaction.attempts,
      ...fields,
    });
    this.observe(transaction.kind, transaction.status.toLowerCase() as ProcessingOutcomeLabel, startedAt);
  }

  /** A transient or unclassified failure: the transaction stays due for a later tick. */
  deferred(candidate: PendingReferenceCandidate, error: unknown): void {
    this.metrics.retried(SOURCE);
    if (error instanceof TransientInfrastructureError && error.reason === "lock_timeout") {
      this.metrics.lockConflict("timeout");
      this.logger.warn("wallet lock timeout", { event: "lock.timeout", ...candidate });
      return;
    }
    this.logger.warn("pending reference retry deferred", {
      event: "pending_reference.retry_deferred",
      ...errorFields(error),
      ...candidate,
    });
  }

  /** A permanent non-business failure; `transaction` is the FAILED one, or undefined if it had settled meanwhile. */
  failed(
    candidate: PendingReferenceCandidate,
    transaction: WagerTransaction | undefined,
    cause: unknown,
    startedAt: number,
  ): void {
    const fields = transaction ? fieldsOf(transaction) : candidate;
    if (transaction) {
      this.metrics.transactionRecorded({ kind: transaction.kind, status: transaction.status, source: SOURCE });
      this.observe(transaction.kind, "error", startedAt);
    }
    this.logger.error("pending reference transaction failed permanently", {
      event: "transaction.failed",
      failureCode: transaction?.failureCode,
      ...errorFields(cause),
      ...fields,
    });
  }

  private observe(kind: string, outcome: ProcessingOutcomeLabel, startedAt: number): void {
    const seconds = (performance.now() - startedAt) / MS_PER_SECOND;
    this.metrics.processingObserved({ kind, source: SOURCE, outcome }, seconds);
  }
}

function fieldsOf(transaction: WagerTransaction): LogFields {
  return {
    correlationId: transaction.correlationId,
    transactionId: transaction.id,
    walletId: transaction.walletId,
    providerId: transaction.providerId,
    kind: transaction.kind,
    status: transaction.status,
  };
}

/** The error's class and stable code only: messages may carry database details. */
function errorFields(error: unknown): LogFields {
  const errorCode = error instanceof ApplicationError || error instanceof DomainError ? error.code : undefined;
  return { errorName: error instanceof Error ? error.name : typeof error, errorCode };
}

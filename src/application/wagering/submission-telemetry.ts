import { ApplicationError, TransientInfrastructureError } from "../errors";
import type { AppLogger } from "../ports/app-logger.port";
import type { ProcessingOutcomeLabel, WageringMetrics } from "../ports/wagering-metrics.port";
import type { ExecutionContext } from "../shared/execution-context";
import type { SubmitWagerTransactionCommand, SubmitWagerTransactionResult } from "./submit-wager-transaction.command";

const CONFLICT_CODES: ReadonlySet<string> = new Set(["IDEMPOTENCY_KEY_CONFLICT", "EXTERNAL_TRANSACTION_CONFLICT"]);
const MS_PER_SECOND = 1000;

/** Logs and metrics of a submission, emitted once its outcome is final (after the commit). */
export class SubmissionTelemetry {
  constructor(
    private readonly logger: AppLogger,
    private readonly metrics: WageringMetrics,
  ) {}

  succeeded(
    { transaction, idempotentReplay }: SubmitWagerTransactionResult,
    context: ExecutionContext,
    startedAt: number,
  ): void {
    const fields = {
      transactionId: transaction.id,
      walletId: transaction.walletId,
      providerId: transaction.providerId,
      kind: transaction.kind,
      status: transaction.status,
      failureCode: transaction.failureCode,
    };
    if (idempotentReplay) {
      this.metrics.duplicateDetected("idempotent_replay");
      this.logger.info("idempotent replay", { event: "idempotency.replay", ...fields });
    } else {
      this.metrics.transactionRecorded({ kind: transaction.kind, status: transaction.status, source: context.source });
      this.logger.info("wager transaction recorded", {
        event: `transaction.${transaction.status.toLowerCase()}`,
        ...fields,
      });
    }
    const outcome = idempotentReplay ? "replay" : (transaction.status.toLowerCase() as ProcessingOutcomeLabel);
    this.observe(transaction.kind, context, outcome, startedAt);
  }

  failed(error: unknown, command: SubmitWagerTransactionCommand, context: ExecutionContext, startedAt: number): void {
    const fields = { walletId: command.walletId, providerId: command.providerId, kind: command.kind };
    const code = error instanceof ApplicationError ? error.code : "INTERNAL_ERROR";
    if (CONFLICT_CODES.has(code)) {
      this.metrics.idempotencyConflict(context.source, code);
      this.logger.warn("conflicting wager transaction", { event: "idempotency.conflict", code, ...fields });
      this.observe(command.kind, context, "conflict", startedAt);
      return;
    }
    if (error instanceof TransientInfrastructureError && error.reason === "lock_timeout") {
      this.metrics.lockConflict("timeout");
      this.logger.warn("wallet lock timeout", { event: "lock.timeout", ...fields });
    }
    this.observe(command.kind, context, "error", startedAt);
  }

  private observe(kind: string, context: ExecutionContext, outcome: ProcessingOutcomeLabel, startedAt: number): void {
    const seconds = (performance.now() - startedAt) / MS_PER_SECOND;
    this.metrics.processingObserved({ kind, source: context.source, outcome }, seconds);
  }
}

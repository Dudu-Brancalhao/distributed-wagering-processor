import { Counter, Gauge, Histogram, type Registry } from "prom-client";
import type {
  DuplicateType,
  LockConflictReason,
  ProcessingLabels,
  RetryComponent,
  TransactionLabels,
  TransactionSource,
  WageringMetrics,
} from "../../application/ports/wagering-metrics.port";

const LOCK_WAIT_BUCKETS_SECONDS = [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2];
const PROCESSING_BUCKETS_SECONDS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
const MS_PER_SECOND = 1000;

/** prom-client implementation of the business metrics (spec 3.18). */
export class PrometheusWageringMetrics implements WageringMetrics {
  private readonly transactions: Counter<"kind" | "status" | "source">;
  private readonly duplicates: Counter<"type">;
  private readonly idempotencyConflicts: Counter<"source" | "code">;
  private readonly retries: Counter<"component">;
  private readonly lockWait: Histogram;
  private readonly lockConflicts: Counter<"reason">;
  private readonly processing: Histogram<"source" | "kind" | "outcome">;
  private readonly reconciliationDivergences: Counter;
  private readonly outboxLag: Gauge;
  private readonly deadLetters: Counter<"reason">;
  private readonly contentionThresholdSeconds: number;

  constructor(registry: Registry, lockContentionThresholdMs: number) {
    const registers = [registry];
    this.contentionThresholdSeconds = lockContentionThresholdMs / MS_PER_SECOND;
    this.transactions = new Counter({
      name: "wagering_transactions_total",
      help: "Wager transactions recorded, by kind, status and entry point",
      labelNames: ["kind", "status", "source"],
      registers,
    });
    this.duplicates = new Counter({
      name: "wagering_duplicates_total",
      help: "Duplicate deliveries and idempotent replays detected",
      labelNames: ["type"],
      registers,
    });
    this.idempotencyConflicts = new Counter({
      name: "wagering_idempotency_conflicts_total",
      help: "Requests conflicting with an existing idempotency key or external transaction id",
      labelNames: ["source", "code"],
      registers,
    });
    this.retries = new Counter({
      name: "wagering_retries_total",
      help: "Retries scheduled or performed, by component",
      labelNames: ["component"],
      registers,
    });
    this.lockWait = new Histogram({
      name: "wagering_wallet_lock_wait_seconds",
      help: "Time to acquire the wallet row lock",
      buckets: LOCK_WAIT_BUCKETS_SECONDS,
      registers,
    });
    this.lockConflicts = new Counter({
      name: "wagering_lock_conflicts_total",
      help: "Lock conflicts: contended waits, lock timeouts and unique-key races",
      labelNames: ["reason"],
      registers,
    });
    this.processing = new Histogram({
      name: "wagering_processing_duration_seconds",
      help: "Wager transaction processing latency",
      labelNames: ["source", "kind", "outcome"],
      buckets: PROCESSING_BUCKETS_SECONDS,
      registers,
    });
    this.reconciliationDivergences = new Counter({
      name: "wagering_reconciliation_divergences_total",
      help: "Wallet reconciliations that found the balance and the ledger diverging",
      registers,
    });
    this.outboxLag = new Gauge({
      name: "wagering_outbox_lag_seconds",
      help: "Age of the oldest unpublished outbox message, sampled each publisher tick",
      registers,
    });
    this.deadLetters = new Counter({
      name: "wagering_dlq_messages_total",
      help: "Messages this service moved to the dead-letter queue, by reason",
      labelNames: ["reason"],
      registers,
    });
  }

  transactionRecorded(labels: TransactionLabels): void {
    this.transactions.inc({ ...labels });
  }

  duplicateDetected(type: DuplicateType): void {
    this.duplicates.inc({ type });
  }

  idempotencyConflict(source: TransactionSource, code: string): void {
    this.idempotencyConflicts.inc({ source, code });
  }

  retried(component: RetryComponent): void {
    this.retries.inc({ component });
  }

  walletLockWaited(seconds: number): void {
    this.lockWait.observe(seconds);
    if (seconds > this.contentionThresholdSeconds) {
      this.lockConflicts.inc({ reason: "contended" });
    }
  }

  lockConflict(reason: LockConflictReason): void {
    this.lockConflicts.inc({ reason });
  }

  processingObserved(labels: ProcessingLabels, seconds: number): void {
    this.processing.observe({ ...labels }, seconds);
  }

  reconciliationDivergence(): void {
    this.reconciliationDivergences.inc();
  }

  outboxLagObserved(seconds: number): void {
    this.outboxLag.set(seconds);
  }

  deadLettered(reason: string): void {
    this.deadLetters.inc({ reason });
  }
}

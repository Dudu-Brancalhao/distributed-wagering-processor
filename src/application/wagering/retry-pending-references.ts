import { DomainError } from "../../domain/shared/domain-error";
import { FailureCode } from "../../domain/wagering/failure-code";
import type { WagerTransaction } from "../../domain/wagering/wager-transaction";
import type { ProcessingOutcome, WagerTransactionProcessor } from "../../domain/wagering/wager-transaction-processor";
import { WagerTransactionStatus } from "../../domain/wagering/wager-transaction-status";
import type { Wallet } from "../../domain/wallet/wallet";
import { IntegrityViolationError } from "../errors";
import type { Clock } from "../ports/clock.port";
import type { IdGenerator } from "../ports/id-generator.port";
import type { LedgerRepository } from "../ports/ledger.repository";
import type { OutboxRepository } from "../ports/outbox.repository";
import type { UnitOfWork } from "../ports/unit-of-work.port";
import type { PendingReferenceCandidate, WagerTransactionRepository } from "../ports/wager-transaction.repository";
import type { WageringMetrics } from "../ports/wagering-metrics.port";
import type { WalletRepository } from "../ports/wallet.repository";
import { eventContexts } from "../shared/event-context-factory";
import { outboxMessagesFor } from "./outcome-events";
import type { PendingReferenceTelemetry } from "./pending-reference-telemetry";
import { lookUpReference } from "./reference-lookup";

/** Candidates read per tick (spec 3.16 step 1). */
export const PENDING_REFERENCE_BATCH_SIZE = 20;
const MS_PER_SECOND = 1000;

export interface RetryPendingReferencesDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly wallets: WalletRepository;
  readonly transactions: WagerTransactionRepository;
  readonly ledger: LedgerRepository;
  readonly outbox: OutboxRepository;
  readonly processor: WagerTransactionProcessor;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly metrics: WageringMetrics;
  readonly telemetry: PendingReferenceTelemetry;
}

/**
 * One tick of the pending-reference retrier (spec 3.16): re-runs the submit rules on every due PENDING_REFERENCE
 * transaction, each in its own SQL transaction under its wallet's row lock. A transient failure leaves the
 * transaction for a later tick; a permanent non-business failure marks it FAILED.
 */
export class RetryPendingReferences {
  constructor(private readonly deps: RetryPendingReferencesDependencies) {}

  /** Returns how many due candidates the tick handled. Errors on one candidate never stop the others. */
  async execute(): Promise<number> {
    const candidates = await this.deps.unitOfWork.isolated(() =>
      this.deps.transactions.findDuePendingReferences(this.deps.clock.now(), PENDING_REFERENCE_BATCH_SIZE),
    );
    for (const candidate of candidates) {
      await this.retryCandidate(candidate);
    }
    return candidates.length;
  }

  private async retryCandidate(candidate: PendingReferenceCandidate): Promise<void> {
    const startedAt = performance.now();
    try {
      const transaction = await this.inOwnTransaction(() => this.retry(candidate));
      this.deps.telemetry.retried(candidate, transaction, startedAt);
    } catch (error) {
      if (!isPermanent(error)) {
        this.deps.telemetry.deferred(candidate, error);
        return;
      }
      await this.failCandidate(candidate, error, startedAt);
    }
  }

  /** Returns the transaction after the retry, or undefined when another instance already handled it. */
  private async retry(candidate: PendingReferenceCandidate): Promise<WagerTransaction | undefined> {
    const wallet = await this.lockWallet(candidate.walletId);
    const transaction = await this.deps.transactions.findById(candidate.transactionId);
    const now = this.deps.clock.now();
    if (!transaction?.isDueForReferenceRetry(now)) return undefined;
    const outcome = this.deps.processor.process({
      transaction,
      wallet,
      ...(await lookUpReference(this.deps.transactions, transaction)),
      entryId: this.deps.ids.next(),
      at: now,
    });
    this.persist(transaction, wallet, outcome, now);
    return transaction;
  }

  private persist(transaction: WagerTransaction, wallet: Wallet, outcome: ProcessingOutcome, now: Date): void {
    this.deps.transactions.updateStatus(transaction);
    // Only the first entry into PENDING_REFERENCE publishes an event (spec 3.6); a reschedule publishes none.
    if (outcome.kind === "awaiting-reference") return;
    const entry = outcome.kind === "applied" ? outcome.entry : undefined;
    if (entry) {
      this.deps.ledger.add(entry);
      this.deps.wallets.updateBalance(wallet);
    }
    // The retry is caused by the transaction itself and continues its original correlation.
    const origin = { correlationId: transaction.correlationId, causationId: transaction.id };
    this.deps.outbox.add(outboxMessagesFor({ transaction, wallet, entry }, eventContexts(this.deps.ids, origin, now)));
  }

  /** Retrying cannot fix a permanent error, so a fresh SQL transaction records it as FAILED (spec 3.16 step 4). */
  private async failCandidate(candidate: PendingReferenceCandidate, cause: unknown, startedAt: number): Promise<void> {
    try {
      const failed = await this.inOwnTransaction(() => this.markFailed(candidate));
      this.deps.telemetry.failed(candidate, failed, cause, startedAt);
    } catch (error) {
      this.deps.telemetry.deferred(candidate, error);
    }
  }

  private async markFailed(candidate: PendingReferenceCandidate): Promise<WagerTransaction | undefined> {
    await this.deps.wallets.lockById(candidate.walletId);
    const transaction = await this.deps.transactions.findById(candidate.transactionId);
    if (transaction?.status !== WagerTransactionStatus.PendingReference) return undefined;
    transaction.fail(FailureCode.ProcessingFailed, this.deps.clock.now());
    this.deps.transactions.updateStatus(transaction);
    return transaction;
  }

  /** A plain `FOR UPDATE` bounded by `lock_timeout`: a busy wallet is waited for, not skipped. */
  private async lockWallet(walletId: string): Promise<Wallet> {
    const startedAt = performance.now();
    const wallet = await this.deps.wallets.lockById(walletId);
    this.deps.metrics.walletLockWaited((performance.now() - startedAt) / MS_PER_SECOND);
    if (!wallet) throw new IntegrityViolationError(`Wallet ${walletId} of a pending transaction does not exist`);
    return wallet;
  }

  /** Every candidate gets a fresh persistence context and its own SQL transaction. */
  private inOwnTransaction<T>(work: () => Promise<T>): Promise<T> {
    return this.deps.unitOfWork.isolated(() => this.deps.unitOfWork.run(work));
  }
}

/**
 * Integrity violations and domain invariant breaches signal a bug or an overflow (spec 3.10). Everything else,
 * including unclassified errors, is retried on a later tick: a wrong "permanent" guess would fail a recoverable
 * transaction for good.
 */
function isPermanent(error: unknown): boolean {
  return error instanceof IntegrityViolationError || error instanceof DomainError;
}

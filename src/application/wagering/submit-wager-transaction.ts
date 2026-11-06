import { WagerTransaction } from "../../domain/wagering/wager-transaction";
import type { WagerTransactionProcessor } from "../../domain/wagering/wager-transaction-processor";
import type { Wallet } from "../../domain/wallet/wallet";
import { ExternalTransactionConflictError, IdempotencyConflictError, WalletNotFoundError } from "../errors";
import type { Clock } from "../ports/clock.port";
import type { IdGenerator } from "../ports/id-generator.port";
import type { LedgerRepository } from "../ports/ledger.repository";
import type { OutboxRepository } from "../ports/outbox.repository";
import type { UnitOfWork } from "../ports/unit-of-work.port";
import type { WagerTransactionRepository } from "../ports/wager-transaction.repository";
import type { WageringMetrics } from "../ports/wagering-metrics.port";
import type { WalletRepository } from "../ports/wallet.repository";
import { eventContexts } from "../shared/event-context-factory";
import type { ExecutionContext } from "../shared/execution-context";
import type { UniqueRaceRetry } from "../shared/unique-race-retry";
import { decideIdempotency } from "./idempotency-decision";
import { outboxMessagesFor } from "./outcome-events";
import { PayloadHash } from "./payload-hash";
import type { SubmissionTelemetry } from "./submission-telemetry";
import type { SubmitWagerTransactionCommand, SubmitWagerTransactionResult } from "./submit-wager-transaction.command";

const MS_PER_SECOND = 1000;

export interface SubmitWagerTransactionDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly raceRetry: UniqueRaceRetry;
  readonly wallets: WalletRepository;
  readonly transactions: WagerTransactionRepository;
  readonly ledger: LedgerRepository;
  readonly outbox: OutboxRepository;
  readonly processor: WagerTransactionProcessor;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly metrics: WageringMetrics;
  readonly telemetry: SubmissionTelemetry;
}

/**
 * Records a provider operation exactly once (spec 3.8): idempotency fast path, wallet row lock, authoritative
 * idempotency check under the lock, domain processing, then transaction, ledger entry, wallet and outbox rows in one
 * SQL transaction.
 */
export class SubmitWagerTransaction {
  constructor(private readonly deps: SubmitWagerTransactionDependencies) {}

  /** Owns its unit of work, so it also handles the unique-key race retry. */
  async execute(
    command: SubmitWagerTransactionCommand,
    context: ExecutionContext,
  ): Promise<SubmitWagerTransactionResult> {
    const startedAt = performance.now();
    try {
      const result = await this.deps.raceRetry.run(() => this.submit(command, context));
      this.deps.telemetry.succeeded(result, context, startedAt);
      return result;
    } catch (error) {
      this.deps.telemetry.failed(error, command, context, startedAt);
      throw error;
    }
  }

  private async submit(
    command: SubmitWagerTransactionCommand,
    context: ExecutionContext,
  ): Promise<SubmitWagerTransactionResult> {
    const payloadHash = PayloadHash.of(command);
    const known = await this.findByIdempotencyKey(command, payloadHash);
    if (known) return known;
    return this.deps.unitOfWork.run(async () => {
      const wallet = await this.lockWallet(command.walletId);
      const knownUnderLock = await this.findByIdempotencyKey(command, payloadHash);
      if (knownUnderLock) return knownUnderLock;
      await this.assertExternalIdUnused(command);
      return { transaction: await this.process(command, payloadHash, wallet, context), idempotentReplay: false };
    });
  }

  private async findByIdempotencyKey(
    command: SubmitWagerTransactionCommand,
    payloadHash: string,
  ): Promise<SubmitWagerTransactionResult | undefined> {
    const existing = await this.deps.transactions.findByIdempotencyKey(command.providerId, command.idempotencyKey);
    if (!existing) return undefined;
    if (decideIdempotency(existing, payloadHash) === "conflict") {
      throw new IdempotencyConflictError("The idempotency key was already used with a different payload");
    }
    return { transaction: existing, idempotentReplay: true };
  }

  private async lockWallet(walletId: string): Promise<Wallet> {
    const startedAt = performance.now();
    const wallet = await this.deps.wallets.lockById(walletId);
    this.deps.metrics.walletLockWaited((performance.now() - startedAt) / MS_PER_SECOND);
    if (!wallet) throw new WalletNotFoundError(walletId, "reference");
    return wallet;
  }

  private async assertExternalIdUnused(command: SubmitWagerTransactionCommand): Promise<void> {
    const existing = await this.deps.transactions.findByExternalId(command.providerId, command.externalTransactionId);
    if (existing) {
      throw new ExternalTransactionConflictError(
        "The external transaction id was already submitted under another idempotency key",
      );
    }
  }

  private async process(
    command: SubmitWagerTransactionCommand,
    payloadHash: string,
    wallet: Wallet,
    context: ExecutionContext,
  ): Promise<WagerTransaction> {
    const now = this.deps.clock.now();
    const transaction = WagerTransaction.create({
      ...command,
      id: this.deps.ids.next(),
      payloadHash,
      correlationId: context.correlationId,
      createdAt: now,
    });
    const reference = await this.resolveReference(command);
    const outcome = this.deps.processor.process({
      transaction,
      wallet,
      reference,
      referenceAlreadyReversed: await this.isAlreadyReversed(transaction, reference),
      entryId: this.deps.ids.next(),
      at: now,
    });
    const entry = outcome.kind === "applied" ? outcome.entry : undefined;
    this.deps.transactions.add(transaction);
    if (entry) {
      this.deps.ledger.add(entry);
      this.deps.wallets.updateBalance(wallet);
    }
    this.deps.outbox.add(outboxMessagesFor({ transaction, wallet, entry }, eventContexts(this.deps.ids, context, now)));
    return transaction;
  }

  private async resolveReference(command: SubmitWagerTransactionCommand): Promise<WagerTransaction | undefined> {
    if (command.referenceExternalTransactionId === undefined) return undefined;
    return this.deps.transactions.findByExternalId(command.providerId, command.referenceExternalTransactionId);
  }

  private async isAlreadyReversed(transaction: WagerTransaction, reference?: WagerTransaction): Promise<boolean> {
    if (!reference || !transaction.isReversal()) return false;
    return this.deps.transactions.hasProcessedReversal(reference.id);
  }
}

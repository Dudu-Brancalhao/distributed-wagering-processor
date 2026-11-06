import { InboxMessage } from "../../domain/messaging/inbox-message";
import { InboxPayloadMismatchError } from "../errors";
import type { AppLogger } from "../ports/app-logger.port";
import type { Clock } from "../ports/clock.port";
import type { InboxRepository } from "../ports/inbox.repository";
import type { UnitOfWork } from "../ports/unit-of-work.port";
import type { WageringMetrics } from "../ports/wagering-metrics.port";
import type { ExecutionContext } from "../shared/execution-context";
import type { UniqueRaceRetry } from "../shared/unique-race-retry";
import type { SubmissionTelemetry } from "../wagering/submission-telemetry";
import type { SubmitWagerTransaction } from "../wagering/submit-wager-transaction";
import type {
  SubmitWagerTransactionCommand,
  SubmitWagerTransactionResult,
} from "../wagering/submit-wager-transaction.command";

/** A validated `WagerTransactionRequested` message. */
export interface WagerTransactionMessage {
  readonly messageId: string;
  /** `InboxPayloadHash` of the message's `data`. */
  readonly payloadHash: string;
  readonly command: SubmitWagerTransactionCommand;
}

export type MessageOutcome =
  | { readonly kind: "submitted"; readonly result: SubmitWagerTransactionResult }
  | { readonly kind: "duplicate" };

export interface ProcessWagerTransactionMessageDependencies {
  readonly consumerName: string;
  readonly unitOfWork: UnitOfWork;
  readonly raceRetry: UniqueRaceRetry;
  readonly inbox: InboxRepository;
  readonly submitWagerTransaction: SubmitWagerTransaction;
  readonly clock: Clock;
  readonly telemetry: SubmissionTelemetry;
  readonly metrics: WageringMetrics;
  readonly logger: AppLogger;
}

/**
 * Handles one queue message exactly once (spec 3.14): the inbox row and the `SubmitWagerTransaction` effects commit
 * in one SQL transaction, so a redelivered message is recognized as a duplicate and never applied twice. This class
 * owns that outermost unit of work, so it retries it once after a unique-key race (spec 3.8).
 */
export class ProcessWagerTransactionMessage {
  constructor(private readonly deps: ProcessWagerTransactionMessageDependencies) {}

  async execute(message: WagerTransactionMessage, context: ExecutionContext): Promise<MessageOutcome> {
    const startedAt = performance.now();
    try {
      const outcome = await this.deps.raceRetry.run(() =>
        this.deps.unitOfWork.run(() => this.process(message, context)),
      );
      this.reportCommitted(outcome, message, context, startedAt);
      return outcome;
    } catch (error) {
      this.deps.telemetry.failed(error, message.command, context, startedAt);
      throw error;
    }
  }

  private async process(message: WagerTransactionMessage, context: ExecutionContext): Promise<MessageOutcome> {
    const received = InboxMessage.receive({
      consumerName: this.deps.consumerName,
      messageId: message.messageId,
      payloadHash: message.payloadHash,
      receivedAt: this.deps.clock.now(),
    });
    const existing = await this.deps.inbox.insertIfAbsent(received);
    if (existing) {
      if (!existing.matchesPayload(message.payloadHash)) throw new InboxPayloadMismatchError(message.messageId);
      return { kind: "duplicate" };
    }
    const result = await this.deps.submitWagerTransaction.submit(message.command, context);
    received.markProcessed(this.deps.clock.now());
    await this.deps.inbox.markProcessed(received);
    return { kind: "submitted", result };
  }

  private reportCommitted(
    outcome: MessageOutcome,
    message: WagerTransactionMessage,
    context: ExecutionContext,
    startedAt: number,
  ): void {
    if (outcome.kind === "submitted") {
      this.deps.telemetry.succeeded(outcome.result, context, startedAt);
      return;
    }
    this.deps.metrics.duplicateDetected("inbox");
    this.deps.logger.info("duplicate message ignored", {
      event: "inbox.duplicate",
      messageId: message.messageId,
      walletId: message.command.walletId,
      providerId: message.command.providerId,
    });
  }
}

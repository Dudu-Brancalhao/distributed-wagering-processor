import { ApplicationError } from "../../application/errors";
import { InboxPayloadHash } from "../../application/messaging/inbox-payload-hash";
import type { ProcessWagerTransactionMessage } from "../../application/messaging/process-wager-transaction-message";
import type { AppLogger } from "../../application/ports/app-logger.port";
import type { WageringMetrics } from "../../application/ports/wagering-metrics.port";
import type { JsonValue } from "../../application/shared/canonical-json";
import type { ExecutionContext } from "../../application/shared/execution-context";
import type { RetrySchedule } from "../../domain/messaging/retry-schedule";
import { LogContext } from "../../infrastructure/observability/log-context";
import type { ReceivedMessage, SqsQueueGateway } from "../../infrastructure/sqs/sqs-queue-gateway";
import { classifyMessageFailure, INVALID_MESSAGE, type MessageFailure } from "./message-failure-classifier";
import { type WagerTransactionEnvelope, wagerTransactionEnvelopeSchema } from "./wager-transaction-envelope.schema";

const MS_PER_SECOND = 1000;

export interface WagerTransactionMessageHandlerDependencies {
  readonly processMessage: ProcessWagerTransactionMessage;
  readonly gateway: SqsQueueGateway;
  /** Backoff of transient failures, applied through the visibility timeout. */
  readonly retrySchedule: RetrySchedule;
  readonly metrics: WageringMetrics;
  readonly logger: AppLogger;
}

interface ParsedMessage {
  readonly envelope: WagerTransactionEnvelope;
  readonly rawData: JsonValue;
}

/**
 * Settles one received message (spec 3.14): processes it, then deletes it only after the commit, schedules a retry
 * through its visibility timeout, or moves it to the dead-letter queue, depending on the outcome.
 */
export class WagerTransactionMessageHandler {
  constructor(private readonly deps: WagerTransactionMessageHandlerDependencies) {}

  async handle(message: ReceivedMessage): Promise<void> {
    const parsed = parse(message.body);
    if (!parsed) {
      await this.settleFailure(message, INVALID_MESSAGE, message.sqsMessageId);
      return;
    }
    const { messageId } = parsed.envelope;
    await LogContext.run({ correlationId: messageId, messageId }, () => this.process(message, parsed));
  }

  private async process(message: ReceivedMessage, { envelope, rawData }: ParsedMessage): Promise<void> {
    const context: ExecutionContext = {
      correlationId: envelope.messageId,
      causationId: envelope.messageId,
      source: "sqs",
    };
    try {
      await this.deps.processMessage.execute(
        { messageId: envelope.messageId, payloadHash: InboxPayloadHash.of(rawData), command: envelope.data },
        context,
      );
    } catch (error) {
      await this.settleFailure(message, classifyMessageFailure(error), envelope.messageId, error);
      return;
    }
    await this.deps.gateway.delete(message);
  }

  private async settleFailure(
    message: ReceivedMessage,
    failure: MessageFailure,
    deduplicationId: string,
    error?: unknown,
  ): Promise<void> {
    switch (failure.kind) {
      case "business":
        await this.deps.gateway.delete(message);
        return;
      case "permanent":
        await this.deadLetter(message, failure.reason, failure.code, deduplicationId);
        return;
      case "transient":
        await this.retryLater(message, error);
        return;
    }
  }

  /** Copy first, then delete: a crash in between leaves a DLQ duplicate that DLQ deduplication absorbs. */
  private async deadLetter(message: ReceivedMessage, reason: string, code: string, deduplicationId: string) {
    await this.deps.gateway.moveToDeadLetter(message, { deduplicationId, failureReason: reason, failureCode: code });
    await this.deps.gateway.delete(message);
    this.deps.metrics.deadLettered(reason);
    this.deps.logger.warn("message moved to the dead-letter queue", {
      event: "sqs.moved_to_dlq",
      reason,
      code,
      sqsMessageId: message.sqsMessageId,
    });
  }

  /** Waits out the backoff of this attempt invisible in the queue; per-message DelaySeconds is not allowed on FIFO. */
  private async retryLater(message: ReceivedMessage, error: unknown) {
    const attempt = message.receiveCount - 1;
    const delaySeconds = Math.ceil(this.deps.retrySchedule.delayMs(attempt) / MS_PER_SECOND);
    await this.deps.gateway.changeVisibility(message, delaySeconds);
    this.deps.metrics.retried("sqs");
    this.deps.logger.warn("message processing failed, retry scheduled", {
      event: "sqs.retry_scheduled",
      receiveCount: message.receiveCount,
      delaySeconds,
      errorCode: error instanceof ApplicationError ? error.code : errorName(error),
      sqsMessageId: message.sqsMessageId,
    });
  }
}

function parse(body: string): ParsedMessage | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return undefined;
  }
  const result = wagerTransactionEnvelopeSchema.safeParse(raw);
  if (!result.success) return undefined;
  return { envelope: result.data, rawData: (raw as { data: JsonValue }).data };
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}

import type { OutboxMessage } from "../../domain/messaging/outbox-message";
import type { RetrySchedule } from "../../domain/messaging/retry-schedule";
import type { AppLogger } from "../ports/app-logger.port";
import type { Clock } from "../ports/clock.port";
import type { EventPublisher } from "../ports/event-publisher.port";
import type { OutboxRepository } from "../ports/outbox.repository";
import type { UnitOfWork } from "../ports/unit-of-work.port";
import type { WageringMetrics } from "../ports/wagering-metrics.port";

export interface PublishOutboxBatchDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly outbox: OutboxRepository;
  readonly publisher: EventPublisher;
  readonly clock: Clock;
  readonly retrySchedule: RetrySchedule;
  readonly metrics: WageringMetrics;
  readonly logger: AppLogger;
  readonly batchSize: number;
}

export interface OutboxBatchResult {
  readonly published: number;
  readonly failed: number;
  /** The batch was full, so more messages may already be due. */
  readonly full: boolean;
}

/**
 * One publisher tick (spec 3.15): in a single SQL transaction, claim due outbox messages with `SKIP LOCKED`, send
 * them, then mark each one published or schedule its retry. The row locks are held during the send, so concurrent
 * publishers get disjoint batches and a crashed publisher's rows become claimable again when its transaction aborts.
 * Messages never give up: a failure only moves the next attempt further out.
 */
export class PublishOutboxBatch {
  constructor(private readonly deps: PublishOutboxBatchDependencies) {}

  execute(): Promise<OutboxBatchResult> {
    const { unitOfWork } = this.deps;
    return unitOfWork.isolated(() => unitOfWork.run(() => this.publishDueMessages()));
  }

  private async publishDueMessages(): Promise<OutboxBatchResult> {
    const messages = await this.deps.outbox.claimDue(this.deps.clock.now(), this.deps.batchSize);
    if (messages.length === 0) return { published: 0, failed: 0, full: false };
    const failures = await this.send(messages);
    const now = this.deps.clock.now();
    for (const message of messages) {
      const failure = failures.get(message.id);
      if (failure === undefined) {
        this.markPublished(message, now);
      } else {
        this.scheduleRetry(message, now, failure);
      }
    }
    const result = {
      published: messages.length - failures.size,
      failed: failures.size,
      full: messages.length === this.deps.batchSize,
    };
    this.report(result, failures);
    return result;
  }

  /** A call that fails as a whole fails every message of the batch with the same reason. */
  private async send(messages: readonly OutboxMessage[]): Promise<ReadonlyMap<string, string>> {
    try {
      return (await this.deps.publisher.publish(messages)).failures;
    } catch (error) {
      const reason = describeError(error);
      return new Map(messages.map((message) => [message.id, reason]));
    }
  }

  private markPublished(message: OutboxMessage, now: Date): void {
    message.markPublished(now);
    this.deps.outbox.saveAttempt(message);
  }

  private scheduleRetry(message: OutboxMessage, now: Date, failure: string): void {
    message.scheduleRetry(now, this.deps.retrySchedule);
    this.deps.outbox.saveAttempt(message, failure);
    this.deps.metrics.retried("outbox");
  }

  private report(result: OutboxBatchResult, failures: ReadonlyMap<string, string>): void {
    if (result.published > 0) {
      this.deps.logger.info("outbox messages published", { event: "outbox.published", count: result.published });
    }
    const [firstFailure] = failures.values();
    if (firstFailure !== undefined) {
      this.deps.logger.warn("outbox messages failed to publish, retry scheduled", {
        event: "outbox.publish_failed",
        count: result.failed,
        reason: firstFailure,
      });
    }
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

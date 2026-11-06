import { setTimeout as sleep } from "node:timers/promises";
import type { BeforeApplicationShutdown, OnApplicationBootstrap } from "@nestjs/common";
import type { AppLogger } from "../../application/ports/app-logger.port";
import type { RetrySchedule } from "../../domain/messaging/retry-schedule";
import type { ReceivedMessage, SqsQueueGateway } from "../../infrastructure/sqs/sqs-queue-gateway";
import { MessageBatch } from "./message-batch";

export interface WagerTransactionConsumerOptions {
  readonly gateway: SqsQueueGateway;
  readonly handle: (message: ReceivedMessage) => Promise<void>;
  readonly logger: AppLogger;
  readonly concurrency: number;
  readonly visibilityTimeoutS: number;
  readonly shutdownGraceMs: number;
  /** Pause between polls while receiving keeps failing (SQS unreachable or throttling). */
  readonly receiveRetrySchedule: RetrySchedule;
}

/**
 * Role `consumer`: long-polls `wager-transactions.fifo` and runs each batch (spec 3.14). On shutdown (spec 3.17) it
 * stops polling at once, returns messages not started yet to the queue, and gives in-flight messages the grace
 * period to commit and be acknowledged before handing them back too.
 */
export class WagerTransactionConsumer implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly stop = new AbortController();
  private polling: Promise<void> = Promise.resolve();
  private batch?: MessageBatch;

  constructor(private readonly options: WagerTransactionConsumerOptions) {}

  onApplicationBootstrap(): void {
    this.polling = this.poll();
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.stop.abort();
    if (!(await this.settlesWithinGrace(this.polling))) {
      this.options.logger.warn("shutdown grace period over, returning in-flight messages to the queue", {
        event: "sqs.grace_exceeded",
      });
      await this.batch?.releaseInFlight();
    }
    this.options.logger.info("consumer stopped", { event: "sqs.consumer_stopped" });
  }

  private async poll(): Promise<void> {
    let consecutiveFailures = 0;
    while (!this.stop.signal.aborted) {
      const messages = await this.receive().catch((error: unknown) => {
        if (!this.stop.signal.aborted) this.logReceiveFailure(error);
        return undefined;
      });
      if (messages) {
        consecutiveFailures = 0;
        await this.runBatch(messages);
      } else {
        await this.pause(this.options.receiveRetrySchedule.delayMs(consecutiveFailures));
        consecutiveFailures += 1;
      }
    }
  }

  private receive(): Promise<ReceivedMessage[]> {
    return this.options.gateway.receive(this.stop.signal);
  }

  private async runBatch(messages: readonly ReceivedMessage[]): Promise<void> {
    if (messages.length === 0) return;
    const { handle, gateway, logger, concurrency, visibilityTimeoutS } = this.options;
    this.batch = new MessageBatch(messages, {
      handle,
      gateway,
      logger,
      concurrency,
      visibilityTimeoutS,
      stopSignal: this.stop.signal,
    });
    try {
      await this.batch.run();
    } finally {
      this.batch = undefined;
    }
  }

  private async pause(delayMs: number): Promise<void> {
    await sleep(delayMs, undefined, { signal: this.stop.signal }).catch(() => undefined);
  }

  private async settlesWithinGrace(work: Promise<void>): Promise<boolean> {
    const grace = new AbortController();
    const deadline = sleep(this.options.shutdownGraceMs, false, { signal: grace.signal }).catch(() => false);
    try {
      return await Promise.race([work.then(() => true), deadline]);
    } finally {
      grace.abort();
    }
  }

  private logReceiveFailure(error: unknown): void {
    this.options.logger.warn("receiving from the wager transaction queue failed", {
      event: "sqs.receive_failed",
      error: error instanceof Error ? error.name : "UnknownError",
    });
  }
}

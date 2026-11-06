import type { AppLogger } from "../../application/ports/app-logger.port";
import type { ReceivedMessage, SqsQueueGateway } from "../../infrastructure/sqs/sqs-queue-gateway";

const MS_PER_SECOND = 1000;
const MAKE_VISIBLE_NOW_S = 0;

export interface MessageBatchOptions {
  readonly handle: (message: ReceivedMessage) => Promise<void>;
  readonly gateway: SqsQueueGateway;
  readonly logger: AppLogger;
  readonly concurrency: number;
  readonly visibilityTimeoutS: number;
  /** Aborted at shutdown: messages not started yet go back to the queue at once. */
  readonly stopSignal: AbortSignal;
}

/**
 * Runs one received batch (spec 3.14): messages of one `MessageGroupId` run in order, groups run in parallel up to
 * the concurrency limit. Group order is only an optimization, so a failed message never stops the rest of its group.
 */
export class MessageBatch {
  private readonly notStarted: Set<ReceivedMessage>;
  private readonly inFlight = new Set<ReceivedMessage>();
  private readonly releases: Promise<void>[] = [];

  constructor(
    messages: readonly ReceivedMessage[],
    private readonly options: MessageBatchOptions,
  ) {
    this.notStarted = new Set(messages);
  }

  async run(): Promise<void> {
    const groups = [...groupByMessageGroup(this.notStarted).values()];
    const onStop = () => this.releaseNotStarted();
    this.options.stopSignal.addEventListener("abort", onStop, { once: true });
    if (this.options.stopSignal.aborted) onStop();
    const workers = Math.min(this.options.concurrency, groups.length);
    try {
      await Promise.all(Array.from({ length: workers }, () => this.drain(groups)));
    } finally {
      this.options.stopSignal.removeEventListener("abort", onStop);
    }
    await Promise.all(this.releases);
  }

  /** Called when the shutdown grace period ends: hands the still running messages to another instance. */
  async releaseInFlight(): Promise<void> {
    await Promise.all([...this.inFlight].map((message) => this.release(message)));
  }

  private async drain(groups: ReceivedMessage[][]): Promise<void> {
    for (let group = groups.shift(); group; group = groups.shift()) {
      for (const message of group) {
        if (this.notStarted.delete(message)) await this.runMessage(message);
      }
    }
  }

  private async runMessage(message: ReceivedMessage): Promise<void> {
    this.inFlight.add(message);
    try {
      await this.keepInvisible(message);
      await this.options.handle(message);
    } catch (error) {
      this.options.logger.error("message settlement failed; it reappears after its visibility timeout", {
        event: "sqs.settle_failed",
        error: error instanceof Error ? error.name : "UnknownError",
        sqsMessageId: message.sqsMessageId,
      });
    } finally {
      this.inFlight.delete(message);
    }
  }

  /** A message that waited past half its visibility timeout gets the full timeout again before it starts. */
  private async keepInvisible(message: ReceivedMessage): Promise<void> {
    const timeoutMs = this.options.visibilityTimeoutS * MS_PER_SECOND;
    if (performance.now() - message.receivedAt > timeoutMs / 2) {
      await this.options.gateway.changeVisibility(message, this.options.visibilityTimeoutS);
    }
  }

  private releaseNotStarted(): void {
    const released = [...this.notStarted];
    this.notStarted.clear();
    this.releases.push(...released.map((message) => this.release(message)));
  }

  private async release(message: ReceivedMessage): Promise<void> {
    try {
      await this.options.gateway.changeVisibility(message, MAKE_VISIBLE_NOW_S);
    } catch {
      this.options.logger.warn("could not release a message; it reappears after its visibility timeout", {
        event: "sqs.release_failed",
        sqsMessageId: message.sqsMessageId,
      });
    }
  }
}

function groupByMessageGroup(messages: Iterable<ReceivedMessage>): Map<string, ReceivedMessage[]> {
  const groups = new Map<string, ReceivedMessage[]>();
  for (const message of messages) {
    const group = groups.get(message.groupId) ?? [];
    group.push(message);
    groups.set(message.groupId, group);
  }
  return groups;
}

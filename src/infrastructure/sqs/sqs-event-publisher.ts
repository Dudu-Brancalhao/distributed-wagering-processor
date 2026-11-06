import {
  GetQueueUrlCommand,
  SendMessageBatchCommand,
  type SendMessageBatchRequestEntry,
  type SQSClient,
} from "@aws-sdk/client-sqs";
import type { EventPublisher, PublishOutcome } from "../../application/ports/event-publisher.port";
import type { OutboxMessage } from "../../domain/messaging/outbox-message";

/** Spec 3.15: a send may hold the outbox row locks for at most this long. */
const SEND_TIMEOUT_MS = 5000;

/**
 * Publishes outbox messages to the events FIFO queue (`wagering-events.fifo`, OQ-16). The group keeps each aggregate's
 * events in order, and the event id as deduplication id lets SQS drop a republished batch within its 5-minute window.
 */
export class SqsEventPublisher implements EventPublisher {
  private queueUrl?: Promise<string>;

  constructor(
    private readonly sqs: SQSClient,
    private readonly queueName: string,
  ) {}

  async publish(messages: readonly OutboxMessage[]): Promise<PublishOutcome> {
    if (messages.length === 0) return { failures: new Map() };
    const response = await this.sqs.send(
      new SendMessageBatchCommand({ QueueUrl: await this.resolveQueueUrl(), Entries: messages.map(toBatchEntry) }),
      { abortSignal: AbortSignal.timeout(SEND_TIMEOUT_MS) },
    );
    const accepted = new Set(response.Successful?.map((entry) => entry.Id));
    const rejected = new Map(response.Failed?.map((entry) => [entry.Id, `${entry.Code}: ${entry.Message ?? ""}`]));
    const failures = new Map(
      messages
        .filter((message) => !accepted.has(message.id))
        .map((message) => [message.id, rejected.get(message.id) ?? "SQS returned no result for the entry"]),
    );
    return { failures };
  }

  /** Looked up once; a failed lookup is retried on the next publish. */
  private resolveQueueUrl(): Promise<string> {
    this.queueUrl ??= this.lookUpQueueUrl().catch((error: unknown) => {
      this.queueUrl = undefined;
      throw error;
    });
    return this.queueUrl;
  }

  private async lookUpQueueUrl(): Promise<string> {
    const { QueueUrl } = await this.sqs.send(new GetQueueUrlCommand({ QueueName: this.queueName }), {
      abortSignal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (!QueueUrl) throw new Error(`SQS returned no URL for queue ${this.queueName}`);
    return QueueUrl;
  }
}

function toBatchEntry(message: OutboxMessage): SendMessageBatchRequestEntry {
  return {
    Id: message.id,
    MessageBody: JSON.stringify(message.payload),
    MessageGroupId: message.aggregateId,
    MessageDeduplicationId: message.id,
    MessageAttributes: {
      eventType: { DataType: "String", StringValue: message.eventType },
      version: { DataType: "Number", StringValue: String(message.payload.version) },
      correlationId: { DataType: "String", StringValue: message.payload.correlationId },
    },
  };
}

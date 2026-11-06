import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from "@aws-sdk/client-sqs";
import { sqsConfigSchema } from "../../src/infrastructure/config/config.schema";
import { loadConfig } from "../../src/infrastructure/config/load-config";
import { createSqsClient } from "../../src/infrastructure/sqs/sqs-client.factory";
import { type ProvisionedQueues, SqsQueueProvisioner } from "../../src/infrastructure/sqs/sqs-queue-provisioner";

export interface QueueNames {
  readonly SQS_WAGER_QUEUE_NAME: string;
  readonly SQS_WAGER_DLQ_NAME: string;
  readonly SQS_EVENTS_QUEUE_NAME: string;
}

export interface TestQueues {
  /** Config overrides that point an application at these queues. */
  readonly names: QueueNames;
  readonly urls: ProvisionedQueues;
  readonly sqs: SQSClient;
}

export interface QueueAttributeOverrides {
  readonly maxReceiveCount?: number;
  readonly visibilityTimeoutS?: number;
}

/**
 * Creates the three FIFO queues under names unique to the caller (spec 3.21), with the production attributes unless
 * overridden: the redrive limit, or a short visibility timeout so a crashed consumer's message comes back quickly.
 */
export async function provisionTestQueues({
  maxReceiveCount,
  visibilityTimeoutS,
}: QueueAttributeOverrides = {}): Promise<TestQueues> {
  const run = Bun.randomUUIDv7().slice(-12);
  const names = {
    SQS_WAGER_QUEUE_NAME: `wager-transactions-${run}.fifo`,
    SQS_WAGER_DLQ_NAME: `wager-transactions-dlq-${run}.fifo`,
    SQS_EVENTS_QUEUE_NAME: `wagering-events-${run}.fifo`,
  };
  const attributes = {
    ...(maxReceiveCount === undefined ? {} : { SQS_MAX_RECEIVE_COUNT: String(maxReceiveCount) }),
    ...(visibilityTimeoutS === undefined ? {} : { SQS_VISIBILITY_TIMEOUT_S: String(visibilityTimeoutS) }),
  };
  const config = loadConfig(sqsConfigSchema, { ...process.env, ...names, ...attributes });
  const sqs = createSqsClient(config);
  return { names, urls: await new SqsQueueProvisioner(sqs, config).provision(), sqs };
}

export interface SendOptions {
  readonly groupId?: string;
  readonly deduplicationId?: string;
}

/** Sends a raw body (a string is sent verbatim, anything else as JSON), with a random group and dedup id. */
export async function sendToWagerQueue(queues: TestQueues, body: unknown, options: SendOptions = {}): Promise<void> {
  await queues.sqs.send(
    new SendMessageCommand({
      QueueUrl: queues.urls.wagerQueueUrl,
      MessageBody: typeof body === "string" ? body : JSON.stringify(body),
      MessageGroupId: options.groupId ?? Bun.randomUUIDv7(),
      MessageDeduplicationId: options.deduplicationId ?? Bun.randomUUIDv7(),
    }),
  );
}

export interface QueueCounts {
  readonly visible: number;
  readonly inFlight: number;
}

export async function queueCounts(queues: TestQueues, queueUrl: string): Promise<QueueCounts> {
  const { Attributes = {} } = await queues.sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: queueUrl,
      AttributeNames: ["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible"],
    }),
  );
  return {
    visible: Number(Attributes.ApproximateNumberOfMessages ?? "0"),
    inFlight: Number(Attributes.ApproximateNumberOfMessagesNotVisible ?? "0"),
  };
}

/** Receives (and leaves in flight) whatever is visible in a queue right now, with its message attributes. */
export async function receiveVisible(queues: TestQueues, queueUrl: string, waitTimeSeconds = 1): Promise<Message[]> {
  const { Messages = [] } = await queues.sqs.send(
    new ReceiveMessageCommand({
      QueueUrl: queueUrl,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: waitTimeSeconds,
      MessageAttributeNames: ["All"],
      MessageSystemAttributeNames: ["ApproximateReceiveCount"],
    }),
  );
  return Messages;
}

export function wagerEnvelope(data: Record<string, unknown>, messageId: string = Bun.randomUUIDv7()) {
  return { messageId, type: "WagerTransactionRequested", occurredAt: new Date().toISOString(), data };
}

/** An application with the consumer role on `queues`, short polls and one-second retry backoff. */
export function consumerAppOverrides(queues: TestQueues, overrides: Record<string, string> = {}) {
  return {
    APP_ROLES: "api,consumer",
    ...queues.names,
    SQS_WAIT_TIME_S: "1",
    SQS_RETRY_BASE_S: "1",
    SQS_RETRY_MAX_S: "1",
    ...overrides,
  };
}

/** Both the visible and the in-flight counts are zero: every message was deleted. */
export async function expectQueueDrained(queues: TestQueues, queueUrl: string): Promise<void> {
  const counts = await queueCounts(queues, queueUrl);
  if (counts.visible !== 0 || counts.inFlight !== 0) {
    throw new Error(`queue not drained: ${JSON.stringify(counts)}`);
  }
}

/**
 * Waits for the dead-lettered copy whose body satisfies `matches`, deletes it and returns it. Other messages are made
 * visible again at once, so tests sharing the queue never hide each other's messages.
 */
export async function takeDeadLetter(
  queues: TestQueues,
  matches: (body: string) => boolean,
  { timeoutMs = 30_000 } = {},
): Promise<Message> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    for (const message of await receiveVisible(queues, queues.urls.deadLetterQueueUrl)) {
      if (matches(message.Body ?? "")) {
        await queues.sqs.send(
          new DeleteMessageCommand({ QueueUrl: queues.urls.deadLetterQueueUrl, ReceiptHandle: message.ReceiptHandle }),
        );
        return message;
      }
      await queues.sqs.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: queues.urls.deadLetterQueueUrl,
          ReceiptHandle: message.ReceiptHandle,
          VisibilityTimeout: 0,
        }),
      );
    }
  }
  throw new Error("no matching message reached the dead-letter queue");
}

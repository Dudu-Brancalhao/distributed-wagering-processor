import { DeleteMessageBatchCommand, type Message, ReceiveMessageCommand, type SQSClient } from "@aws-sdk/client-sqs";
import type { IntegrationEventEnvelope } from "../../src/domain/events/integration-event";
import { sqsConfigSchema } from "../../src/infrastructure/config/config.schema";
import { loadConfig } from "../../src/infrastructure/config/load-config";
import { createSqsClient } from "../../src/infrastructure/sqs/sqs-client.factory";
import { type ProvisionedQueues, SqsQueueProvisioner } from "../../src/infrastructure/sqs/sqs-queue-provisioner";

/** Queue names unique to one test file, so files never read each other's messages (spec 3.21). */
export function uniqueQueueNames(): Record<string, string> {
  const run = Bun.randomUUIDv7().slice(-12);
  return {
    SQS_WAGER_QUEUE_NAME: `wager-transactions-${run}.fifo`,
    SQS_WAGER_DLQ_NAME: `wager-transactions-dlq-${run}.fifo`,
    SQS_EVENTS_QUEUE_NAME: `wagering-events-${run}.fifo`,
  };
}

export interface TestQueues {
  readonly sqs: SQSClient;
  readonly queues: ProvisionedQueues;
}

export async function provisionQueues(names: Record<string, string>): Promise<TestQueues> {
  const config = loadConfig(sqsConfigSchema, { ...process.env, ...names });
  const sqs = createSqsClient(config);
  return { sqs, queues: await new SqsQueueProvisioner(sqs, config).provision() };
}

export interface ReceivedEvent {
  readonly envelope: IntegrationEventEnvelope<unknown>;
  readonly groupId?: string;
  readonly deduplicationId?: string;
  readonly attributes: Readonly<Record<string, string | undefined>>;
}

/**
 * Receives and deletes events from `queueUrl` until `isComplete` accepts everything received so far, or fails after
 * `timeoutMs`. Deleting each message unblocks its FIFO group for the next receive.
 */
export async function receiveEvents(
  sqs: SQSClient,
  queueUrl: string,
  isComplete: (received: readonly ReceivedEvent[]) => boolean,
  { timeoutMs = 8000 } = {},
): Promise<ReceivedEvent[]> {
  const received: ReceivedEvent[] = [];
  const deadline = Date.now() + timeoutMs;
  while (!isComplete(received)) {
    if (Date.now() >= deadline) throw new Error(`Timed out after receiving ${received.length} events`);
    const messages = await receiveBatch(sqs, queueUrl);
    received.push(...messages.map(toReceivedEvent));
    await deleteBatch(sqs, queueUrl, messages);
  }
  return received;
}

async function receiveBatch(sqs: SQSClient, queueUrl: string): Promise<Message[]> {
  const { Messages = [] } = await sqs.send(
    new ReceiveMessageCommand({
      QueueUrl: queueUrl,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: 1,
      MessageSystemAttributeNames: ["MessageGroupId", "MessageDeduplicationId"],
      MessageAttributeNames: ["All"],
    }),
  );
  return Messages;
}

async function deleteBatch(sqs: SQSClient, queueUrl: string, messages: readonly Message[]): Promise<void> {
  if (messages.length === 0) return;
  await sqs.send(
    new DeleteMessageBatchCommand({
      QueueUrl: queueUrl,
      Entries: messages.map((message, index) => ({ Id: String(index), ReceiptHandle: message.ReceiptHandle })),
    }),
  );
}

function toReceivedEvent(message: Message): ReceivedEvent {
  const attributes = Object.fromEntries(
    Object.entries(message.MessageAttributes ?? {}).map(([name, value]) => [name, value.StringValue]),
  );
  return {
    envelope: JSON.parse(message.Body ?? "null"),
    groupId: message.Attributes?.MessageGroupId,
    deduplicationId: message.Attributes?.MessageDeduplicationId,
    attributes,
  };
}

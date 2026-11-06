import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from "@aws-sdk/client-sqs";
import type { SqsConfig } from "../config/config.schema";
import type { SqsQueueUrls } from "./sqs-queue-urls";

/** A message received from the wager transaction queue. `receivedAt` is a `performance.now()` timestamp. */
export interface ReceivedMessage {
  readonly sqsMessageId: string;
  readonly body: string;
  readonly receiptHandle: string;
  readonly groupId: string;
  readonly receiveCount: number;
  readonly receivedAt: number;
}

export interface DeadLetter {
  /** Deduplication id in the DLQ, so a crash between the move and the delete only yields an absorbed duplicate. */
  readonly deduplicationId: string;
  readonly failureReason: string;
  readonly failureCode: string;
}

type GatewayConfig = Pick<
  SqsConfig,
  "SQS_WAGER_QUEUE_NAME" | "SQS_WAGER_DLQ_NAME" | "SQS_WAIT_TIME_S" | "SQS_BATCH_SIZE"
>;

/** The consumer's operations on `wager-transactions.fifo` and its dead-letter queue (spec 3.14, 3.18). */
export class SqsQueueGateway {
  constructor(
    private readonly sqs: SQSClient,
    private readonly queues: SqsQueueUrls,
    private readonly config: GatewayConfig,
  ) {}

  /** Long-polls one batch; aborting the signal ends the poll early with an `AbortError`. */
  async receive(abortSignal: AbortSignal): Promise<ReceivedMessage[]> {
    const { Messages = [] } = await this.sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: await this.queues.urlOf(this.config.SQS_WAGER_QUEUE_NAME, abortSignal),
        MaxNumberOfMessages: this.config.SQS_BATCH_SIZE,
        WaitTimeSeconds: this.config.SQS_WAIT_TIME_S,
        MessageSystemAttributeNames: ["ApproximateReceiveCount", "MessageGroupId"],
      }),
      { abortSignal },
    );
    const receivedAt = performance.now();
    return Messages.map((message) => toReceivedMessage(message, receivedAt));
  }

  async delete(message: ReceivedMessage): Promise<void> {
    await this.sqs.send(
      new DeleteMessageCommand({ QueueUrl: await this.wagerQueueUrl(), ReceiptHandle: message.receiptHandle }),
    );
  }

  /** Makes the message visible again after `seconds`; 0 hands it to the next receiver at once. */
  async changeVisibility(message: ReceivedMessage, seconds: number): Promise<void> {
    await this.sqs.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: await this.wagerQueueUrl(),
        ReceiptHandle: message.receiptHandle,
        VisibilityTimeout: seconds,
      }),
    );
  }

  /** Copies the body to the DLQ with the failure as attributes. The caller deletes the original afterwards. */
  async moveToDeadLetter(message: ReceivedMessage, deadLetter: DeadLetter): Promise<void> {
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: await this.queues.urlOf(this.config.SQS_WAGER_DLQ_NAME),
        MessageBody: message.body,
        MessageGroupId: message.groupId,
        MessageDeduplicationId: deadLetter.deduplicationId,
        MessageAttributes: {
          failureReason: { DataType: "String", StringValue: deadLetter.failureReason },
          failureCode: { DataType: "String", StringValue: deadLetter.failureCode },
        },
      }),
    );
  }

  /** Messages waiting in the dead-letter queue, whether this service or the redrive policy moved them there. */
  async deadLetterDepth(): Promise<number> {
    const { Attributes = {} } = await this.sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: await this.queues.urlOf(this.config.SQS_WAGER_DLQ_NAME),
        AttributeNames: ["ApproximateNumberOfMessages"],
      }),
    );
    return Number.parseInt(Attributes.ApproximateNumberOfMessages ?? "0", 10);
  }

  private wagerQueueUrl(): Promise<string> {
    return this.queues.urlOf(this.config.SQS_WAGER_QUEUE_NAME);
  }
}

function toReceivedMessage(message: Message, receivedAt: number): ReceivedMessage {
  const { MessageId, Body, ReceiptHandle, Attributes = {} } = message;
  if (!MessageId || Body === undefined || !ReceiptHandle) {
    throw new Error("SQS returned a message without id, body or receipt handle");
  }
  return {
    sqsMessageId: MessageId,
    body: Body,
    receiptHandle: ReceiptHandle,
    groupId: Attributes.MessageGroupId ?? MessageId,
    receiveCount: Number.parseInt(Attributes.ApproximateReceiveCount ?? "1", 10),
    receivedAt,
  };
}

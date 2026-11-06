import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  QueueNameExists,
  SetQueueAttributesCommand,
  type SQSClient,
} from "@aws-sdk/client-sqs";
import type { SqsConfig } from "../config/config.schema";

export interface ProvisionedQueues {
  readonly wagerQueueUrl: string;
  readonly deadLetterQueueUrl: string;
  readonly eventsQueueUrl: string;
}

/** Creates the FIFO queues of spec 3.14 or brings existing ones to the expected attributes. Safe to run repeatedly. */
export class SqsQueueProvisioner {
  constructor(
    private readonly sqs: SQSClient,
    private readonly config: SqsConfig,
  ) {}

  async provision(): Promise<ProvisionedQueues> {
    const deadLetterQueueUrl = await this.ensureQueue(this.config.SQS_WAGER_DLQ_NAME, {});
    const deadLetterQueueArn = await this.queueArn(deadLetterQueueUrl);
    const wagerQueueUrl = await this.ensureQueue(this.config.SQS_WAGER_QUEUE_NAME, {
      VisibilityTimeout: String(this.config.SQS_VISIBILITY_TIMEOUT_S),
      RedrivePolicy: JSON.stringify({
        deadLetterTargetArn: deadLetterQueueArn,
        maxReceiveCount: this.config.SQS_MAX_RECEIVE_COUNT,
      }),
    });
    const eventsQueueUrl = await this.ensureQueue(this.config.SQS_EVENTS_QUEUE_NAME, {});
    return { wagerQueueUrl, deadLetterQueueUrl, eventsQueueUrl };
  }

  private async ensureQueue(name: string, attributes: Record<string, string>): Promise<string> {
    const fifoAttributes = { FifoQueue: "true", ContentBasedDeduplication: "false", ...attributes };
    try {
      const created = await this.sqs.send(new CreateQueueCommand({ QueueName: name, Attributes: fifoAttributes }));
      return this.requireUrl(created.QueueUrl, name);
    } catch (error) {
      if (!(error instanceof QueueNameExists)) throw error;
      const existing = await this.sqs.send(new GetQueueUrlCommand({ QueueName: name }));
      const url = this.requireUrl(existing.QueueUrl, name);
      if (Object.keys(attributes).length > 0) {
        await this.sqs.send(new SetQueueAttributesCommand({ QueueUrl: url, Attributes: attributes }));
      }
      return url;
    }
  }

  private async queueArn(queueUrl: string): Promise<string> {
    const result = await this.sqs.send(
      new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ["QueueArn"] }),
    );
    const arn = result.Attributes?.QueueArn;
    if (!arn) throw new Error(`Queue ${queueUrl} has no ARN`);
    return arn;
  }

  private requireUrl(url: string | undefined, name: string): string {
    if (!url) throw new Error(`SQS returned no URL for queue ${name}`);
    return url;
  }
}

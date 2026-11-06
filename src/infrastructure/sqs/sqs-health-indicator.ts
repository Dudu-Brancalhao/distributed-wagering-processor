import { GetQueueAttributesCommand, type SQSClient } from "@aws-sdk/client-sqs";
import type { DependencyStatus } from "../persistence/database-health-indicator";
import type { SqsQueueUrls } from "./sqs-queue-urls";

/** Readiness probe for SQS: `GetQueueAttributes` on the wager queue, bounded by a timeout. */
export class SqsHealthIndicator {
  constructor(
    private readonly sqs: SQSClient,
    private readonly queues: SqsQueueUrls,
    private readonly queueName: string,
    private readonly timeoutMs: number,
  ) {}

  async check(): Promise<DependencyStatus> {
    const abortSignal = AbortSignal.timeout(this.timeoutMs);
    try {
      const QueueUrl = await this.queues.urlOf(this.queueName, abortSignal);
      await this.sqs.send(new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ["QueueArn"] }), { abortSignal });
      return "ok";
    } catch {
      return "unavailable";
    }
  }
}

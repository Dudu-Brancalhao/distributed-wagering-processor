import { GetQueueUrlCommand, type SQSClient } from "@aws-sdk/client-sqs";

/**
 * Resolves queue URLs by name on first use and caches them. Resolving lazily lets the process start, and report
 * itself not ready, while SQS is unreachable; a failed lookup is retried on the next call.
 */
export class SqsQueueUrls {
  private readonly urls = new Map<string, Promise<string>>();

  constructor(private readonly sqs: SQSClient) {}

  urlOf(queueName: string, abortSignal?: AbortSignal): Promise<string> {
    const cached = this.urls.get(queueName);
    if (cached) return cached;
    const lookup = this.lookup(queueName, abortSignal);
    this.urls.set(queueName, lookup);
    lookup.catch(() => this.urls.delete(queueName));
    return lookup;
  }

  private async lookup(queueName: string, abortSignal?: AbortSignal): Promise<string> {
    const { QueueUrl } = await this.sqs.send(new GetQueueUrlCommand({ QueueName: queueName }), { abortSignal });
    if (!QueueUrl) throw new Error(`SQS returned no URL for queue ${queueName}`);
    return QueueUrl;
  }
}

import { describe, expect, test } from "bun:test";
import { GetQueueAttributesCommand, SendMessageCommand } from "@aws-sdk/client-sqs";
import { sqsConfigSchema } from "../../../src/infrastructure/config/config.schema";
import { loadConfig } from "../../../src/infrastructure/config/load-config";
import { createSqsClient } from "../../../src/infrastructure/sqs/sqs-client.factory";
import { SqsQueueProvisioner } from "../../../src/infrastructure/sqs/sqs-queue-provisioner";

/** Runs against the Compose SQS emulator (MiniStack by default) with queue names unique to this run. */
const run = Bun.randomUUIDv7().slice(-12);
const config = loadConfig(sqsConfigSchema, {
  ...process.env,
  SQS_WAGER_QUEUE_NAME: `wager-transactions-${run}.fifo`,
  SQS_WAGER_DLQ_NAME: `wager-transactions-dlq-${run}.fifo`,
  SQS_EVENTS_QUEUE_NAME: `wagering-events-${run}.fifo`,
});
const sqs = createSqsClient(config);

async function attributes(queueUrl: string) {
  const result = await sqs.send(new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ["All"] }));
  return result.Attributes ?? {};
}

describe("SqsQueueProvisioner", () => {
  test("creates the three FIFO queues with the redrive policy, and is idempotent", async () => {
    const provisioner = new SqsQueueProvisioner(sqs, config);
    const first = await provisioner.provision();
    const second = await provisioner.provision();
    expect(second).toEqual(first);

    const wager = await attributes(first.wagerQueueUrl);
    const deadLetter = await attributes(first.deadLetterQueueUrl);
    expect(wager.FifoQueue).toBe("true");
    expect(wager.VisibilityTimeout).toBe(String(config.SQS_VISIBILITY_TIMEOUT_S));
    expect(JSON.parse(wager.RedrivePolicy ?? "{}")).toEqual({
      deadLetterTargetArn: deadLetter.QueueArn,
      maxReceiveCount: config.SQS_MAX_RECEIVE_COUNT,
    });
    expect(deadLetter.FifoQueue).toBe("true");
    expect((await attributes(first.eventsQueueUrl)).FifoQueue).toBe("true");
  });

  test("FIFO queues require explicit deduplication ids (content-based deduplication is off)", async () => {
    const { wagerQueueUrl } = await new SqsQueueProvisioner(sqs, config).provision();
    const withoutDedupId = sqs.send(
      new SendMessageCommand({ QueueUrl: wagerQueueUrl, MessageBody: "{}", MessageGroupId: "g" }),
    );
    await expect(withoutDedupId).rejects.toThrow();
  });
});

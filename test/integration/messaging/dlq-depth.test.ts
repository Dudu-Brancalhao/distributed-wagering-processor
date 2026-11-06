import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ChangeMessageVisibilityCommand } from "@aws-sdk/client-sqs";
import { eventually } from "../../support/eventually";
import { metricValue } from "../../support/metrics";
import {
  consumerAppOverrides,
  provisionTestQueues,
  queueCounts,
  receiveVisible,
  sendToWagerQueue,
  type TestQueues,
} from "../../support/sqs-test-queues";
import { startTestApp, type TestApp } from "../../support/test-app";

/**
 * Challenge section 12 "messages in DLQ": `wagering_dlq_depth` samples the DLQ itself, so it also counts the messages
 * the redrive policy moved, which `wagering_dlq_messages_total` (explicit moves only) never sees.
 */
let queues: TestQueues;
let app: TestApp;

/** Receives the message once and hands it back, so with `maxReceiveCount` 1 the next receive redrives it. */
async function exhaustReceivesOfOneMessage(): Promise<void> {
  const [message] = await receiveVisible(queues, queues.urls.wagerQueueUrl);
  if (!message) throw new Error("the message never became visible");
  await queues.sqs.send(
    new ChangeMessageVisibilityCommand({
      QueueUrl: queues.urls.wagerQueueUrl,
      ReceiptHandle: message.ReceiptHandle,
      VisibilityTimeout: 0,
    }),
  );
  await eventually(
    async () => {
      expect(await receiveVisible(queues, queues.urls.wagerQueueUrl, 0)).toEqual([]);
      expect((await queueCounts(queues, queues.urls.deadLetterQueueUrl)).visible).toBe(1);
    },
    { timeoutMs: 10_000 },
  );
}

const depth = () => metricValue(app, "wagering_dlq_depth", `queue="${queues.names.SQS_WAGER_DLQ_NAME}"`);
const explicitMoves = () => metricValue(app, "wagering_dlq_messages_total");

beforeAll(async () => {
  queues = await provisionTestQueues({ maxReceiveCount: 1 });
  await sendToWagerQueue(queues, "moved by the redrive policy");
  await exhaustReceivesOfOneMessage();
  app = await startTestApp(consumerAppOverrides(queues, { SQS_DLQ_DEPTH_SAMPLE_INTERVAL_MS: "100" }));
});

afterAll(async () => {
  await app?.close();
});

describe("wagering_dlq_depth", () => {
  test("counts a message the redrive policy moved, which the explicit-move counter misses", async () => {
    await eventually(async () => expect(await depth()).toBe(1), { timeoutMs: 10_000 });
    expect(await explicitMoves()).toBe(0);
  });

  test("counts the consumer's own moves as well", async () => {
    await sendToWagerQueue(queues, "not json");

    await eventually(async () => expect(await depth()).toBe(2), { timeoutMs: 10_000 });
    expect(await explicitMoves()).toBe(1);
  });
});

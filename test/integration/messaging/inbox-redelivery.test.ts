import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { APP_CONFIG } from "../../../src/infrastructure/config/app-config.token";
import { SQS_CLIENT } from "../../../src/infrastructure/sqs/sqs.tokens";
import { type ReceivedMessage, SqsQueueGateway } from "../../../src/infrastructure/sqs/sqs-queue-gateway";
import { SqsQueueUrls } from "../../../src/infrastructure/sqs/sqs-queue-urls";
import { eventually } from "../../support/eventually";
import {
  consumerAppOverrides,
  expectQueueDrained,
  provisionTestQueues,
  sendToWagerQueue,
  type TestQueues,
  wagerEnvelope,
} from "../../support/sqs-test-queues";
import { startCustomizedTestApp, type TestApp } from "../../support/test-app";
import { createWallet, newId, newProviderId, wagerBody } from "../../support/wagering-requests";
import { inboxRow, ledgerEntryCount, transactionRows } from "../../support/wagering-rows";
import { checkWalletsAfterEach } from "../../support/wallet-consistency";

/** T-I4: a redelivered message, whatever the cause, has exactly one effect and is acknowledged every time. */

/**
 * Loses the first acknowledgement of an armed message the way a crash after the commit would: instead of the delete,
 * the message is made visible again at once.
 */
class AckLosingGateway extends SqsQueueGateway {
  private readonly armed = new Set<string>();

  loseFirstAckOf(messageId: string): void {
    this.armed.add(messageId);
  }

  override async delete(message: ReceivedMessage): Promise<void> {
    if (this.armed.delete(JSON.parse(message.body).messageId)) {
      await this.changeVisibility(message, 0);
      return;
    }
    await super.delete(message);
  }
}

let queues: TestQueues;
let app: TestApp;
let gateway: AckLosingGateway;
const touchedWallets = checkWalletsAfterEach();

beforeAll(async () => {
  queues = await provisionTestQueues();
  app = await startCustomizedTestApp(consumerAppOverrides(queues), (builder) =>
    builder.overrideProvider(SqsQueueGateway).useFactory({
      factory: (sqs, urls, config) => {
        gateway = new AckLosingGateway(sqs, urls, config);
        return gateway;
      },
      inject: [SQS_CLIENT, SqsQueueUrls, APP_CONFIG],
    }),
  );
});

afterAll(async () => {
  await app.close();
});

const duplicateLogs = (messageId: string) =>
  app.logLines.filter((line) => line.includes('"inbox.duplicate"') && line.includes(messageId));

describe("inbox deduplication", () => {
  test("the same messageId sent twice with different dedup ids has one effect and both copies are acked", async () => {
    const wallet = await createWallet(app, "100.00");
    touchedWallets.add(wallet.id);
    const providerId = newProviderId();
    const bet = wagerBody({ providerId, wallet, kind: "BET", amount: "10.00" });
    const message = wagerEnvelope({ ...bet, idempotencyKey: `${providerId}:${bet.externalTransactionId}` });
    await sendToWagerQueue(queues, message);
    await sendToWagerQueue(queues, { ...message, occurredAt: new Date(Date.now() + 1000).toISOString() });

    await eventually(() => expectQueueDrained(queues, queues.urls.wagerQueueUrl), { timeoutMs: 30_000 });
    expect(await transactionRows(providerId)).toMatchObject([{ kind: "BET", status: "PROCESSED" }]);
    expect(await ledgerEntryCount(wallet.id)).toBe(2);
    expect((await inboxRow(message.messageId))?.processed_at).toBeInstanceOf(Date);
    expect(duplicateLogs(message.messageId)).toHaveLength(1);
  });

  test("a message made visible again after its commit (lost ack) is recognized as a duplicate and acked", async () => {
    const wallet = await createWallet(app, "100.00");
    touchedWallets.add(wallet.id);
    const providerId = newProviderId();
    const win = wagerBody({ providerId, wallet, kind: "WIN", amount: "15.00" });
    const message = wagerEnvelope({ ...win, idempotencyKey: newId() });
    gateway.loseFirstAckOf(message.messageId);
    await sendToWagerQueue(queues, message);

    await eventually(() => expectQueueDrained(queues, queues.urls.wagerQueueUrl), { timeoutMs: 30_000 });
    expect(await transactionRows(providerId)).toMatchObject([{ kind: "WIN", status: "PROCESSED" }]);
    expect(await ledgerEntryCount(wallet.id)).toBe(2);
    expect(duplicateLogs(message.messageId)).toHaveLength(1);
  });
});

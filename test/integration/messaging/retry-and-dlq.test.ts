import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Message } from "@aws-sdk/client-sqs";
import { eventually } from "../../support/eventually";
import { pausePostgres, unpausePostgres } from "../../support/postgres-outage";
import { sql } from "../../support/sql";
import {
  consumerAppOverrides,
  expectQueueDrained,
  provisionTestQueues,
  sendToWagerQueue,
  type TestQueues,
  takeDeadLetter,
  wagerEnvelope,
} from "../../support/sqs-test-queues";
import { startTestApp, type TestApp } from "../../support/test-app";
import {
  createWallet,
  newId,
  newProviderId,
  type TestWallet,
  type WagerOptions,
  wagerBody,
} from "../../support/wagering-requests";
import { inboxRow, transactionRows } from "../../support/wagering-rows";
import { checkWalletsAfterEach } from "../../support/wallet-consistency";

/** T-I5: business outcomes are acked, permanent failures go to the DLQ at once, transient ones are retried. */
const touchedWallets = checkWalletsAfterEach();

function wagerMessage(options: WagerOptions, overrides: { idempotencyKey?: string; messageId?: string } = {}) {
  const data = wagerBody(options);
  const idempotencyKey = overrides.idempotencyKey ?? `${options.providerId}:${data.externalTransactionId}`;
  return wagerEnvelope({ ...data, idempotencyKey }, overrides.messageId);
}

function attributes(message: Message) {
  return {
    failureReason: message.MessageAttributes?.failureReason?.StringValue,
    failureCode: message.MessageAttributes?.failureCode?.StringValue,
  };
}

const withMessageId = (messageId: string) => (body: string) => body.includes(messageId);

describe("business outcomes and permanent failures", () => {
  let queues: TestQueues;
  let app: TestApp;

  beforeAll(async () => {
    queues = await provisionTestQueues();
    app = await startTestApp(consumerAppOverrides(queues));
  });

  afterAll(async () => {
    await app.close();
  });

  async function fundedWallet(amount = "100.00"): Promise<TestWallet> {
    const wallet = await createWallet(app, amount);
    touchedWallets.add(wallet.id);
    return wallet;
  }

  test("a business rejection is acked with a REJECTED row and WagerTransactionRejected in the outbox", async () => {
    const wallet = await fundedWallet("5.00");
    const providerId = newProviderId();
    const message = wagerMessage({ providerId, wallet, kind: "BET", amount: "10.00" });
    await sendToWagerQueue(queues, message);

    await eventually(async () => expect(await inboxRow(message.messageId)).toBeDefined(), { timeoutMs: 20_000 });
    await eventually(() => expectQueueDrained(queues, queues.urls.wagerQueueUrl), { timeoutMs: 10_000 });
    expect(await transactionRows(providerId)).toMatchObject([
      { kind: "BET", status: "REJECTED", failure_code: "INSUFFICIENT_FUNDS" },
    ]);
    const events = await sql`
      SELECT event_type FROM outbox_messages WHERE payload->>'correlationId' = ${message.messageId}`;
    expect([...events]).toEqual([{ event_type: "WagerTransactionRejected" }]);
  });

  test("an idempotency conflict is acked, logged and leaves no inbox row (OQ-23)", async () => {
    const wallet = await fundedWallet();
    const providerId = newProviderId();
    const original = wagerMessage({ providerId, wallet, kind: "BET", amount: "10.00" });
    await sendToWagerQueue(queues, original);
    await eventually(async () => expect(await inboxRow(original.messageId)).toBeDefined(), { timeoutMs: 20_000 });

    const conflicting = wagerEnvelope({ ...original.data, money: { amount: "11.00", currency: "BRL" } });
    await sendToWagerQueue(queues, conflicting);
    await eventually(
      () =>
        expect(
          app.logLines.some((line) => line.includes('"idempotency.conflict"') && line.includes(conflicting.messageId)),
        ).toBe(true),
      { timeoutMs: 20_000 },
    );
    await eventually(() => expectQueueDrained(queues, queues.urls.wagerQueueUrl), { timeoutMs: 10_000 });
    expect(await inboxRow(conflicting.messageId)).toBeUndefined();
    expect(await transactionRows(providerId)).toHaveLength(1);
  });

  test("an unparsable body goes to the DLQ on its first receive", async () => {
    const body = `not json ${newId()}`;
    await sendToWagerQueue(queues, body);
    const deadLetter = await takeDeadLetter(queues, (candidate) => candidate === body);
    expect(attributes(deadLetter)).toEqual({ failureReason: "invalid_message", failureCode: "VALIDATION_FAILED" });
  });

  test("an invalid envelope (unsupported type, JSON number money) goes to the DLQ on its first receive", async () => {
    const wallet = await fundedWallet();
    const providerId = newProviderId();
    const unsupported = { ...wagerMessage({ providerId, wallet, kind: "BET", amount: "1.00" }), type: "Other" };
    const numericMoney = wagerMessage({ providerId, wallet, kind: "BET", amount: "1.00" });
    const withNumber = { ...numericMoney, data: { ...numericMoney.data, money: { amount: 1, currency: "BRL" } } };
    await sendToWagerQueue(queues, unsupported);
    await sendToWagerQueue(queues, withNumber);

    for (const message of [unsupported, withNumber]) {
      const deadLetter = await takeDeadLetter(queues, withMessageId(message.messageId));
      expect(attributes(deadLetter)).toEqual({ failureReason: "invalid_message", failureCode: "VALIDATION_FAILED" });
    }
    expect(await transactionRows(providerId)).toEqual([]);
  });

  test("an unknown wallet goes to the DLQ on its first receive", async () => {
    const providerId = newProviderId();
    const message = wagerMessage({
      providerId,
      wallet: { id: newId(), playerId: newId() },
      kind: "BET",
      amount: "1.00",
    });
    await sendToWagerQueue(queues, message);
    const deadLetter = await takeDeadLetter(queues, withMessageId(message.messageId));
    expect(attributes(deadLetter)).toEqual({ failureReason: "wallet_not_found", failureCode: "WALLET_NOT_FOUND" });
    expect(deadLetter.Attributes?.ApproximateReceiveCount).toBe("1");
    expect(await inboxRow(message.messageId)).toBeUndefined();
  });

  test("a messageId reused with a different payload goes to the DLQ (OQ-22) and changes nothing", async () => {
    const wallet = await fundedWallet();
    const providerId = newProviderId();
    const original = wagerMessage({ providerId, wallet, kind: "BET", amount: "10.00" });
    await sendToWagerQueue(queues, original);
    await eventually(async () => expect(await inboxRow(original.messageId)).toBeDefined(), { timeoutMs: 20_000 });

    const reused = wagerMessage(
      { providerId, wallet, kind: "BET", amount: "20.00" },
      { messageId: original.messageId },
    );
    await sendToWagerQueue(queues, reused);
    const deadLetter = await takeDeadLetter(queues, (body) => body.includes(String(reused.data.externalTransactionId)));
    expect(attributes(deadLetter)).toEqual({
      failureReason: "inbox_payload_mismatch",
      failureCode: "INBOX_PAYLOAD_MISMATCH",
    });
    expect(await transactionRows(providerId)).toHaveLength(1);
  });
});

/** Backoff grows 1, 2, 4, 8 s; the client-side timeouts bound each attempt against the frozen server. */
const outageOverrides = (queues: TestQueues, clientTimeouts: { connectMs: number; queryMs: number }) =>
  consumerAppOverrides(queues, {
    SQS_RETRY_BASE_S: "1",
    SQS_RETRY_MAX_S: "8",
    DB_CONNECT_TIMEOUT_MS: String(clientTimeouts.connectMs),
    DB_QUERY_TIMEOUT_MS: String(clientTimeouts.queryMs),
  });

const OUTAGE_TEST_TIMEOUT_MS = 150_000;

function retryDelays(app: TestApp, messageId: string): number[] {
  return app.logLines
    .filter((line) => line.includes('"sqs.retry_scheduled"') && line.includes(messageId))
    .map((line) => JSON.parse(line).delaySeconds);
}

describe("transient failures (PostgreSQL paused)", () => {
  let queues: TestQueues;
  let app: TestApp;

  beforeAll(async () => {
    /** Room for the attempts right after the outage, which may still hit connections broken by it. */
    queues = await provisionTestQueues({ maxReceiveCount: 10 });
    /** Lenient, so attempts after the outage are not failed by a slow but working server. */
    app = await startTestApp(outageOverrides(queues, { connectMs: 5000, queryMs: 8000 }));
  });

  afterAll(async () => {
    await unpausePostgres();
    await app.close();
  });

  test(
    "a message is retried with a growing visibility timeout and succeeds once PostgreSQL is back",
    async () => {
      const wallet = await createWallet(app, "100.00");
      touchedWallets.add(wallet.id);
      const providerId = newProviderId();
      const message = wagerMessage({ providerId, wallet, kind: "BET", amount: "10.00" });
      await pausePostgres();
      try {
        await sendToWagerQueue(queues, message);
        await eventually(() => expect(retryDelays(app, message.messageId).length).toBeGreaterThanOrEqual(3), {
          timeoutMs: 60_000,
        });
      } finally {
        await unpausePostgres();
      }
      const [first, , third] = retryDelays(app, message.messageId);
      expect(third).toBeGreaterThan(first ?? Number.POSITIVE_INFINITY);

      await eventually(() => expectQueueDrained(queues, queues.urls.wagerQueueUrl), { timeoutMs: 60_000 });
      expect(await transactionRows(providerId)).toMatchObject([{ kind: "BET", status: "PROCESSED" }]);
    },
    OUTAGE_TEST_TIMEOUT_MS,
  );
});

describe("attempt limit before the DLQ (PostgreSQL kept down)", () => {
  let queues: TestQueues;
  let app: TestApp;

  beforeAll(async () => {
    queues = await provisionTestQueues();
    /** Short, so the five attempts against the frozen server fail fast. */
    app = await startTestApp(outageOverrides(queues, { connectMs: 1000, queryMs: 2000 }));
  });

  afterAll(async () => {
    await unpausePostgres();
    await app.close();
  });

  test(
    "the redrive policy moves the message to the DLQ after 5 receives, without a failure reason",
    async () => {
      const wallet = await createWallet(app, "100.00");
      touchedWallets.add(wallet.id);
      const providerId = newProviderId();
      const message = wagerMessage({ providerId, wallet, kind: "BET", amount: "10.00" });
      let deadLetter: Message;
      await pausePostgres();
      try {
        await sendToWagerQueue(queues, message);
        deadLetter = await takeDeadLetter(queues, withMessageId(message.messageId), { timeoutMs: 120_000 });
      } finally {
        await unpausePostgres();
      }
      expect(retryDelays(app, message.messageId)).toHaveLength(5);
      expect(attributes(deadLetter)).toEqual({ failureReason: undefined, failureCode: undefined });
      expect(await transactionRows(providerId)).toEqual([]);
    },
    OUTAGE_TEST_TIMEOUT_MS,
  );
});

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { DeleteMessageCommand, type Message } from "@aws-sdk/client-sqs";
import type { Subprocess } from "bun";
import { eventually } from "../../support/eventually";
import { sql } from "../../support/sql";
import {
  expectQueueDrained,
  provisionTestQueues,
  receiveVisible,
  sendToWagerQueue,
  type TestQueues,
  wagerEnvelope,
} from "../../support/sqs-test-queues";
import { startTestApp, type TestApp } from "../../support/test-app";
import { TEST_DATABASE_URL } from "../../support/test-config";
import { createWallet, newProviderId, type TestWallet, wagerBody } from "../../support/wagering-requests";
import { transactionRows } from "../../support/wagering-rows";
import { checkWalletsAfterEach } from "../../support/wallet-consistency";

/**
 * T-I6: SIGTERM to a real consumer process while one message waits on a wallet row lock held by the test. The
 * in-flight message still commits and is acked; the messages received but not started go back to the queue at once.
 */
const SHUTDOWN_TEST_TIMEOUT_MS = 120_000;
const STARTUP_TIMEOUT_MS = 60_000;
/** Far below the 30 s visibility timeout: only an explicit release makes a received message visible this soon. */
const RELEASE_DEADLINE_MS = 10_000;
/** Generous enough that the in-flight message waits on the lock for the whole test instead of timing out. */
const LONG_DATABASE_TIMEOUT_MS = "60000";

let queues: TestQueues;
let api: TestApp;
const touchedWallets = checkWalletsAfterEach();

beforeAll(async () => {
  queues = await provisionTestQueues();
  api = await startTestApp();
});

afterAll(async () => {
  await api.close();
});

function startConsumerProcess(port: number): Subprocess<"ignore", "pipe", "inherit"> {
  return Bun.spawn(["bun", "src/main.ts"], {
    env: {
      ...process.env,
      ...queues.names,
      DATABASE_URL: TEST_DATABASE_URL,
      APP_ROLES: "consumer",
      PORT: String(port),
      INSTANCE_ID: "graceful-shutdown",
      SQS_WAIT_TIME_S: "1",
      SQS_HANDLER_CONCURRENCY: "1",
      SHUTDOWN_GRACE_MS: "30000",
      DB_LOCK_TIMEOUT_MS: LONG_DATABASE_TIMEOUT_MS,
      DB_STATEMENT_TIMEOUT_MS: LONG_DATABASE_TIMEOUT_MS,
      DB_TRANSACTION_TIMEOUT_MS: LONG_DATABASE_TIMEOUT_MS,
      DB_IDLE_IN_TRANSACTION_TIMEOUT_MS: LONG_DATABASE_TIMEOUT_MS,
      DB_QUERY_TIMEOUT_MS: "65000",
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "inherit",
  });
}

async function readiness(port: number): Promise<number> {
  return (await fetch(`http://127.0.0.1:${port}/health/ready`)).status;
}

/** Collects messages that became visible again, across as many receives as it takes. */
async function receiveReturnedMessages(count: number): Promise<Message[]> {
  const returned: Message[] = [];
  await eventually(
    async () => {
      returned.push(...(await receiveVisible(queues, queues.urls.wagerQueueUrl)));
      expect(returned).toHaveLength(count);
    },
    { timeoutMs: RELEASE_DEADLINE_MS },
  );
  return returned;
}

async function lockWaiters(): Promise<number> {
  const [{ count }] = await sql`
    SELECT COUNT(*)::int AS count FROM pg_stat_activity
    WHERE datname = current_database() AND wait_event_type = 'Lock'`;
  return count;
}

function betMessage(wallet: TestWallet, providerId: string) {
  const bet = wagerBody({ providerId, wallet, kind: "BET", amount: "10.00" });
  return wagerEnvelope({ ...bet, idempotencyKey: `${providerId}:${bet.externalTransactionId}` });
}

describe("graceful shutdown", () => {
  test(
    "SIGTERM finishes the in-flight message and returns unstarted messages to the queue at once",
    async () => {
      const wallet = await createWallet(api, "100.00");
      touchedWallets.add(wallet.id);
      const providerId = newProviderId();
      const messages = [betMessage(wallet, providerId), betMessage(wallet, providerId), betMessage(wallet, providerId)];
      for (const message of messages) await sendToWagerQueue(queues, message);

      const lock = await sql.reserve();
      await lock`BEGIN`;
      await lock`SELECT id FROM wallets WHERE id = ${wallet.id} FOR UPDATE`;
      const port = 40_000 + Math.floor(Math.random() * 10_000);
      const consumer = startConsumerProcess(port);
      const logs = new Response(consumer.stdout).text();
      try {
        await eventually(async () => expect(await readiness(port)).toBe(200), { timeoutMs: STARTUP_TIMEOUT_MS });
        await eventually(async () => expect(await lockWaiters()).toBe(1), { timeoutMs: 30_000 });

        consumer.kill("SIGTERM");
        await eventually(async () => expect(await readiness(port)).toBe(503), { timeoutMs: 10_000 });
        const returned = await receiveReturnedMessages(2);
        expect(returned.map((message) => message.Attributes?.ApproximateReceiveCount)).toEqual(["2", "2"]);
        for (const message of returned) {
          await queues.sqs.send(
            new DeleteMessageCommand({ QueueUrl: queues.urls.wagerQueueUrl, ReceiptHandle: message.ReceiptHandle }),
          );
        }
      } catch (error) {
        consumer.kill("SIGKILL");
        console.error(await logs);
        throw error;
      } finally {
        await lock`COMMIT`;
        lock.release();
      }

      await consumer.exited;
      expect((await logs).includes('"shutdown.completed"')).toBe(true);
      expect(await transactionRows(providerId)).toMatchObject([{ kind: "BET", status: "PROCESSED" }]);
      await expectQueueDrained(queues, queues.urls.wagerQueueUrl);
    },
    SHUTDOWN_TEST_TIMEOUT_MS,
  );
});

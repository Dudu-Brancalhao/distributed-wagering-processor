import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { eventually } from "../support/eventually";
import { type Instances, spawnInstances } from "../support/instances";
import { metricValue } from "../support/metrics";
import {
  expectQueueDrained,
  provisionTestQueues,
  queueCounts,
  sendToWagerQueue,
  type TestQueues,
  wagerEnvelope,
} from "../support/sqs-test-queues";
import { createWallet, newProviderId, wagerBody } from "../support/wagering-requests";
import { inboxRow, transactionRows } from "../support/wagering-rows";
import { checkWalletsAfterEach, debitCount } from "../support/wallet-consistency";

/**
 * T-C5 (challenge section 13, concurrency item 5): a consumer process killed after its commit and before
 * `DeleteMessage`. SQS redelivers the message to another process once the visibility timeout ends; the inbox makes
 * that delivery a duplicate, so the bet is debited exactly once.
 */
const CRASH_ENTRYPOINT = join(import.meta.dir, "..", "support", "entrypoints", "crash-after-commit-before-ack.ts");
const VISIBILITY_TIMEOUT_S = 3;
const REDELIVERY_TIMEOUT_MS = 30_000;

let queues: TestQueues;
let consumerEnv: Record<string, string>;
const spawned: Instances[] = [];
const touchedWallets = checkWalletsAfterEach();

async function spawn(options: Parameters<typeof spawnInstances>[1]): Promise<Instances> {
  const instances = await spawnInstances(1, options);
  spawned.push(instances);
  return instances;
}

beforeAll(async () => {
  queues = await provisionTestQueues({ visibilityTimeoutS: VISIBILITY_TIMEOUT_S });
  consumerEnv = {
    ...queues.names,
    SQS_VISIBILITY_TIMEOUT_S: String(VISIBILITY_TIMEOUT_S),
    SQS_WAIT_TIME_S: "1",
  };
});

afterAll(async () => {
  await Promise.all(spawned.map((instances) => instances.close()));
});

describe("a consumer killed after the commit and before the ack", () => {
  test("another process gets the message after the visibility timeout, sees the inbox duplicate and acks it", async () => {
    const crashing = await spawn({ roles: "api,consumer", env: consumerEnv, entrypoint: CRASH_ENTRYPOINT });
    const wallet = await createWallet(crashing.pick(0), "100.00");
    touchedWallets.add(wallet.id);
    const providerId = newProviderId();
    const bet = wagerBody({ providerId, wallet, kind: "BET", amount: "30.00" });
    const message = wagerEnvelope({ ...bet, idempotencyKey: `${providerId}:${bet.externalTransactionId}` });
    await sendToWagerQueue(queues, message);

    expect(await crashing.exited()).toEqual(["SIGKILL"]);
    expect(await transactionRows(providerId)).toMatchObject([{ kind: "BET", status: "PROCESSED" }]);
    expect(await debitCount(wallet.id)).toBe(1);
    expect((await inboxRow(message.messageId))?.processed_at).toBeInstanceOf(Date);
    const { visible, inFlight } = await queueCounts(queues, queues.urls.wagerQueueUrl);
    expect(visible + inFlight).toBe(1);

    const survivor = await spawn({ roles: "api,consumer", env: consumerEnv });
    await eventually(() => expectQueueDrained(queues, queues.urls.wagerQueueUrl), {
      timeoutMs: REDELIVERY_TIMEOUT_MS,
    });

    expect(await metricValue(survivor.pick(0), "wagering_duplicates_total", 'type="inbox"')).toBe(1);
    expect(await transactionRows(providerId)).toMatchObject([{ kind: "BET", status: "PROCESSED" }]);
    expect(await debitCount(wallet.id)).toBe(1);
    expect((await survivor.pick(0).request("GET", `/wallets/${wallet.id}`)).body).toMatchObject({
      balance: { amount: "70.00", currency: "BRL" },
      version: 2,
    });
    await expectQueueDrained(queues, queues.urls.deadLetterQueueUrl);
  });
});

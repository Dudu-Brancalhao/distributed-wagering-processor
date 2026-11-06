import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { receiveEvents } from "../support/event-queue";
import { eventually } from "../support/eventually";
import { type Instances, spawnInstances } from "../support/instances";
import { sql } from "../support/sql";
import {
  expectQueueDrained,
  provisionTestQueues,
  sendToWagerQueue,
  type TestQueues,
  wagerEnvelope,
} from "../support/sqs-test-queues";
import type { HttpResponse } from "../support/test-app";
import {
  createWallet,
  newId,
  newProviderId,
  submit,
  type TestWallet,
  type WagerOptions,
  wagerBody,
} from "../support/wagering-requests";
import { checkWalletsAfterEach, debitCount } from "../support/wallet-consistency";

/**
 * T-C8 (challenge section 13, concurrency item 8 and "recovery after restart"): 3 processes with every role take HTTP
 * and SQS load, all of them are SIGKILLed mid-load, more messages arrive while nothing runs, and 3 fresh processes
 * take over. Once the consumer, the outbox publisher and the pending-reference retrier have caught up, every wallet
 * matches its ledger, nothing was applied twice, every committed event was published, and replays still answer from
 * PostgreSQL.
 */
const INSTANCES = 3;
const ALL_ROLES = "api,consumer,outbox,pending-reference";
const VISIBILITY_TIMEOUT_S = 3;
const WALLETS = 4;
const SQS_MESSAGES_PER_WALLET = 8;
const HTTP_RESPONSES_BEFORE_KILL = 24;
const CATCH_UP_TIMEOUT_MS = 60_000;

interface HttpBet {
  readonly body: ReturnType<typeof wagerBody>;
  /** Unset when the process died before answering: the bet may or may not have committed. */
  response?: HttpResponse;
}

let queues: TestQueues;
let env: Record<string, string>;
let instances: Instances | undefined;
const touchedWallets = checkWalletsAfterEach();

beforeAll(async () => {
  queues = await provisionTestQueues({ visibilityTimeoutS: VISIBILITY_TIMEOUT_S });
  env = {
    ...queues.names,
    SQS_VISIBILITY_TIMEOUT_S: String(VISIBILITY_TIMEOUT_S),
    SQS_WAIT_TIME_S: "1",
    SQS_RETRY_BASE_S: "1",
    SQS_RETRY_MAX_S: "1",
    OUTBOX_POLL_INTERVAL_MS: "100",
    PENDING_REFERENCE_POLL_INTERVAL_MS: "100",
    PENDING_REFERENCE_RETRY_BASE_MS: "100",
    PENDING_REFERENCE_RETRY_MAX_MS: "500",
  };
});

afterAll(async () => {
  await instances?.close();
});

const startInstances = () => spawnInstances(INSTANCES, { roles: ALL_ROLES, env });

/** Sends one SQS message per wallet and round, alternating 2.00 bets and 3.00 wins, and returns how many it sent. */
async function sendSqsWave(providerId: string, wallets: readonly TestWallet[]): Promise<number> {
  const sends = wallets.flatMap((wallet) =>
    Array.from({ length: SQS_MESSAGES_PER_WALLET }, (_, round) =>
      sendWager({
        providerId,
        wallet,
        ...(round % 2 === 0 ? { kind: "BET", amount: "2.00" } : { kind: "WIN", amount: "3.00" }),
      }),
    ),
  );
  await Promise.all(sends);
  return sends.length;
}

function sendWager(options: WagerOptions): Promise<void> {
  const body = wagerBody(options);
  return sendToWagerQueue(
    queues,
    wagerEnvelope({ ...body, idempotencyKey: `${body.providerId}:${body.externalTransactionId}` }),
  );
}

interface HttpLoad {
  readonly target: Instances;
  readonly providerId: string;
  readonly wallets: readonly TestWallet[];
  /** Every bet sent, recorded before it is sent. */
  readonly bets: HttpBet[];
  readonly stopped: () => boolean;
}

/** One lane per wallet keeps sending 1.00 bets over HTTP, round-robin across instances, until stopped or a crash. */
async function runHttpLanes({ target, providerId, wallets, bets, stopped }: HttpLoad): Promise<void> {
  let sent = 0;
  await Promise.all(
    wallets.map(async (wallet) => {
      while (!stopped()) {
        const bet: HttpBet = { body: wagerBody({ providerId, wallet, kind: "BET", amount: "1.00" }) };
        bets.push(bet);
        try {
          bet.response = await submit(target.pick(sent++), bet.body);
        } catch {
          return;
        }
      }
    }),
  );
}

async function unsettledCount(providerId: string): Promise<number> {
  const [{ count }] = await sql`
    SELECT COUNT(*)::int AS count FROM wager_transactions
    WHERE provider_id = ${providerId} AND status = 'PENDING_REFERENCE'`;
  return count;
}

/** Outbox rows of this test's wallets and of every transaction on them, openings included. */
async function outboxRows(providerId: string): Promise<{ id: string; published: boolean }[]> {
  const rows = await sql`
    WITH test_wallets AS (SELECT DISTINCT wallet_id AS id FROM wager_transactions WHERE provider_id = ${providerId})
    SELECT id::text AS id, published_at IS NOT NULL AS published FROM outbox_messages
    WHERE aggregate_id IN (SELECT id FROM test_wallets)
       OR aggregate_id IN (SELECT id FROM wager_transactions WHERE wallet_id IN (SELECT id FROM test_wallets))`;
  return [...rows];
}

async function statusCounts(providerId: string): Promise<Record<string, number>> {
  const rows: { status: string; count: number }[] = await sql`
    SELECT status, COUNT(*)::int AS count FROM wager_transactions WHERE provider_id = ${providerId} GROUP BY status`;
  return Object.fromEntries(rows.map((row) => [row.status, row.count]));
}

async function betCount(providerId: string, walletId: string): Promise<number> {
  const [{ count }] = await sql`
    SELECT COUNT(*)::int AS count FROM wager_transactions
    WHERE provider_id = ${providerId} AND wallet_id = ${walletId} AND kind = 'BET'`;
  return count;
}

describe("restart of every instance under load", () => {
  test("SIGKILL of all 3 processes mid-load, then fresh processes: final state consistent and fully published", async () => {
    const original = await startInstances();
    instances = original;
    const providerId = newProviderId();
    const wallets = await Promise.all(
      Array.from({ length: WALLETS }, (_, index) => createWallet(original.pick(index), "1000.00")),
    );
    for (const wallet of wallets) touchedWallets.add(wallet.id);

    // A refund per wallet whose bet only arrives after the restart: the retrier must settle it then.
    const lateBetIds = wallets.map(() => newId());
    const refunds = await Promise.all(
      wallets.map((wallet, index) =>
        submit(
          original.pick(index),
          wagerBody({
            providerId,
            wallet,
            kind: "REFUND",
            amount: "5.00",
            referenceExternalTransactionId: lateBetIds[index],
          }),
        ),
      ),
    );
    expect(refunds.map((response) => response.body.status)).toEqual(wallets.map(() => "PENDING_REFERENCE"));

    const httpBets: HttpBet[] = [];
    let killing = false;
    const lanes = runHttpLanes({ target: original, providerId, wallets, bets: httpBets, stopped: () => killing });
    let sqsMessages = await sendSqsWave(providerId, wallets);
    await eventually(
      () => expect(httpBets.filter((bet) => bet.response).length).toBeGreaterThanOrEqual(HTTP_RESPONSES_BEFORE_KILL),
      { timeoutMs: 30_000 },
    );

    killing = true;
    await original.kill("SIGKILL");
    instances = undefined;
    await lanes;
    sqsMessages += await sendSqsWave(providerId, wallets);

    const restarted = await startInstances();
    instances = restarted;
    await Promise.all(
      wallets.map((wallet, index) =>
        sendWager({ providerId, wallet, kind: "BET", amount: "5.00", externalTransactionId: lateBetIds[index] }),
      ),
    );

    for (const [index, bet] of httpBets.entries()) {
      const resent = await submit(restarted.pick(index), bet.body);
      if (bet.response) {
        expect(resent.body).toEqual({ ...bet.response.body, idempotentReplay: true });
      } else {
        expect(`${resent.status} ${resent.body.status}`).toBe("201 PROCESSED");
      }
    }

    await eventually(
      async () => {
        await expectQueueDrained(queues, queues.urls.wagerQueueUrl);
        expect(await unsettledCount(providerId)).toBe(0);
        expect((await outboxRows(providerId)).filter((row) => !row.published)).toEqual([]);
      },
      { timeoutMs: CATCH_UP_TIMEOUT_MS },
    );

    const expectedTransactions = refunds.length + httpBets.length + sqsMessages + lateBetIds.length;
    expect(await statusCounts(providerId)).toEqual({ PROCESSED: expectedTransactions });
    for (const wallet of wallets) {
      expect(await debitCount(wallet.id)).toBe(await betCount(providerId, wallet.id));
    }
    await expectQueueDrained(queues, queues.urls.deadLetterQueueUrl);

    const eventIds = new Set((await outboxRows(providerId)).map((row) => row.id));
    const received = await receiveEvents(
      queues.sqs,
      queues.urls.eventsQueueUrl,
      (events) => {
        const seen = new Set(events.map((event) => event.envelope.eventId));
        return [...eventIds].every((id) => seen.has(id));
      },
      { timeoutMs: 30_000 },
    );
    expect(received.length).toBeGreaterThanOrEqual(eventIds.size);
  }, 180_000);
});

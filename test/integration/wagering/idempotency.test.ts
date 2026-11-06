import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eventually } from "../../support/eventually";
import {
  consumerAppOverrides,
  expectQueueDrained,
  provisionTestQueues,
  sendToWagerQueue,
  wagerEnvelope,
} from "../../support/sqs-test-queues";
import { startTestApp, type TestApp } from "../../support/test-app";
import { createWallet, newProviderId, submit, wagerBody } from "../../support/wagering-requests";
import { inboxRow, transactionRows } from "../../support/wagering-rows";
import { checkWalletsAfterEach } from "../../support/wallet-consistency";

/** T-I3 (HTTP part): replays return the original result, conflicts are never replays. */
let app: TestApp;
const touchedWallets = checkWalletsAfterEach();

beforeAll(async () => {
  app = await startTestApp();
});

afterAll(async () => {
  await app.close();
});

describe("idempotency over HTTP", () => {
  test("a replay returns the original result and the balance observed then, after the balance moved", async () => {
    const wallet = await createWallet(app, "100.00");
    touchedWallets.add(wallet.id);
    const providerId = newProviderId();
    const bet = wagerBody({ providerId, wallet, kind: "BET", amount: "30.00" });
    const original = await submit(app, bet);
    await submit(app, wagerBody({ providerId, wallet, kind: "BET", amount: "50.00" }));

    const replay = await submit(app, bet);
    expect(replay.status).toBe(original.status);
    expect(replay.body).toEqual({ ...original.body, idempotentReplay: true });
    expect(replay.body.balance).toEqual({ amount: "70.00", currency: "BRL" });
    expect((await app.request("GET", `/wallets/${wallet.id}`)).body.balance).toEqual({
      amount: "20.00",
      currency: "BRL",
    });
  });

  test("a rejected outcome replays as the same rejection, even once funds would allow it", async () => {
    const wallet = await createWallet(app, "10.00");
    touchedWallets.add(wallet.id);
    const providerId = newProviderId();
    const bet = wagerBody({ providerId, wallet, kind: "BET", amount: "15.00" });
    const original = await submit(app, bet);
    await submit(app, wagerBody({ providerId, wallet, kind: "WIN", amount: "50.00" }));
    const replay = await submit(app, bet);
    expect(replay.status).toBe(422);
    expect(replay.body).toEqual({ ...original.body, idempotentReplay: true });
  });

  test("the same key with a divergent payload is a conflict and changes nothing", async () => {
    const wallet = await createWallet(app, "100.00");
    touchedWallets.add(wallet.id);
    const providerId = newProviderId();
    const bet = wagerBody({ providerId, wallet, kind: "BET", amount: "30.00" });
    const key = `${providerId}:${bet.externalTransactionId}`;
    await submit(app, bet, key);
    for (const divergent of [
      { ...bet, roundId: "round-2" },
      { ...bet, money: { amount: "30.01", currency: "BRL" } },
    ]) {
      const response = await submit(app, divergent, key);
      expect(response.status).toBe(409);
      expect(response.body.code).toBe("IDEMPOTENCY_KEY_CONFLICT");
    }
    expect((await app.request("GET", `/wallets/${wallet.id}`)).body).toMatchObject({
      balance: { amount: "70.00" },
      version: 2,
    });
  });

  test("transport differences that are not business fields are still a replay", async () => {
    const wallet = await createWallet(app, "100.00");
    touchedWallets.add(wallet.id);
    const bet = wagerBody({ providerId: newProviderId(), wallet, kind: "BET", amount: "1.00" });
    await submit(app, bet);
    const reordered = Object.fromEntries(Object.entries(bet).reverse());
    const replay = await submit(app, {
      ...reordered,
      walletId: wallet.id.toUpperCase(),
      unknownField: "ignored",
    });
    expect(replay.body.idempotentReplay).toBe(true);
  });
});

describe("idempotency across entry points", () => {
  test("a request sent over HTTP and then over SQS with the same key is a replay", async () => {
    const queues = await provisionTestQueues();
    const consumer = await startTestApp(consumerAppOverrides(queues));
    try {
      const wallet = await createWallet(consumer, "100.00");
      touchedWallets.add(wallet.id);
      const providerId = newProviderId();
      const bet = wagerBody({ providerId, wallet, kind: "BET", amount: "30.00" });
      const idempotencyKey = `${providerId}:${bet.externalTransactionId}`;
      const original = await submit(consumer, bet, idempotencyKey);
      expect(original.status).toBe(201);

      const message = wagerEnvelope({ ...bet, idempotencyKey });
      await sendToWagerQueue(queues, message);
      await eventually(async () => expect((await inboxRow(message.messageId))?.processed_at).toBeInstanceOf(Date), {
        timeoutMs: 20_000,
      });
      await eventually(() => expectQueueDrained(queues, queues.urls.wagerQueueUrl), { timeoutMs: 10_000 });
      expect(await transactionRows(providerId)).toMatchObject([
        { id: original.body.transactionId, status: "PROCESSED" },
      ]);
      expect(
        consumer.logLines.some((line) => line.includes('"idempotency.replay"') && line.includes(message.messageId)),
      ).toBe(true);
      expect((await consumer.request("GET", `/wallets/${wallet.id}`)).body.balance).toEqual({
        amount: "70.00",
        currency: "BRL",
      });
    } finally {
      await consumer.close();
    }
  });
});

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "../../support/sql";
import { startTestApp, type TestApp } from "../../support/test-app";
import { createWallet, newId, newProviderId, submit, wagerBody } from "../../support/wagering-requests";
import { checkWalletsAfterEach } from "../../support/wallet-consistency";

/** T-I7: the wagering endpoints of the spec 3.13 table. */
const LOCK_TIMEOUT_MS = "300";
let app: TestApp;
const touchedWallets = checkWalletsAfterEach();

beforeAll(async () => {
  app = await startTestApp({ DB_LOCK_TIMEOUT_MS: LOCK_TIMEOUT_MS });
});

afterAll(async () => {
  await app.close();
});

async function fundedWallet(amount = "100.00") {
  const wallet = await createWallet(app, amount);
  touchedWallets.add(wallet.id);
  return { wallet, providerId: newProviderId() };
}

describe("POST /wagering/transactions outcomes (first response and replay alike)", () => {
  test("201 PROCESSED with the contract body", async () => {
    const { wallet, providerId } = await fundedWallet("1000.00");
    const body = wagerBody({ providerId, wallet, kind: "BET", amount: "25.00" });
    const first = await submit(app, body);
    expect(first.status).toBe(201);
    expect(first.body).toEqual({
      transactionId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      status: "PROCESSED",
      balance: { amount: "975.00", currency: "BRL" },
      idempotentReplay: false,
    });
    const replay = await submit(app, body);
    expect(replay.status).toBe(201);
    expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
  });

  test("202 PENDING_REFERENCE for a reversal whose reference has not arrived", async () => {
    const { wallet, providerId } = await fundedWallet();
    const body = wagerBody({
      providerId,
      wallet,
      kind: "ROLLBACK",
      amount: "5.00",
      referenceExternalTransactionId: newId(),
    });
    const first = await submit(app, body);
    expect(first.status).toBe(202);
    expect(first.body).toMatchObject({ status: "PENDING_REFERENCE", balance: { amount: "100.00", currency: "BRL" } });
    expect((await submit(app, body)).status).toBe(202);
  });

  test("422 REJECTED carries code and failureCode; PLAYER_WALLET_MISMATCH withholds the balance", async () => {
    const { wallet, providerId } = await fundedWallet("10.00");
    const broke = await submit(app, wagerBody({ providerId, wallet, kind: "BET", amount: "10.01" }));
    expect(broke.status).toBe(422);
    expect(broke.body).toMatchObject({
      status: "REJECTED",
      failureCode: "INSUFFICIENT_FUNDS",
      code: "INSUFFICIENT_FUNDS",
      balance: { amount: "10.00", currency: "BRL" },
    });

    const dollars = await submit(app, wagerBody({ providerId, wallet, kind: "BET", amount: "1.00", currency: "USD" }));
    expect(dollars.status).toBe(422);
    expect(dollars.body).toMatchObject({
      failureCode: "CURRENCY_MISMATCH",
      balance: { amount: "10.00", currency: "BRL" },
    });

    const stranger = { ...wallet, playerId: newId() };
    const mismatch = await submit(app, wagerBody({ providerId, wallet: stranger, kind: "BET", amount: "1.00" }));
    expect(mismatch.status).toBe(422);
    expect(mismatch.body.failureCode).toBe("PLAYER_WALLET_MISMATCH");
    expect(mismatch.body).not.toHaveProperty("balance");
  });

  test("WIN credits, LOSS of zero is processed without moving the balance", async () => {
    const { wallet, providerId } = await fundedWallet("10.00");
    const bet = wagerBody({ providerId, wallet, kind: "BET", amount: "4.00" });
    await submit(app, bet);
    const win = await submit(
      app,
      wagerBody({
        providerId,
        wallet,
        kind: "WIN",
        amount: "6.00",
        referenceExternalTransactionId: bet.externalTransactionId,
      }),
    );
    expect(win.body).toMatchObject({ status: "PROCESSED", balance: { amount: "12.00", currency: "BRL" } });
    const loss = await submit(app, wagerBody({ providerId, wallet, kind: "LOSS", amount: "0.00" }));
    expect(loss.status).toBe(201);
    expect(loss.body.balance).toEqual({ amount: "12.00", currency: "BRL" });
  });
});

describe("POST /wagering/transactions request errors", () => {
  test("400 for a missing or malformed Idempotency-Key", async () => {
    const { wallet, providerId } = await fundedWallet();
    const body = wagerBody({ providerId, wallet, kind: "BET", amount: "1.00" });
    const missing = await app.request("POST", "/wagering/transactions", { body });
    expect(missing.status).toBe(400);
    expect(missing.body).toMatchObject({
      code: "VALIDATION_FAILED",
      details: [{ path: "Idempotency-Key", message: "required" }],
    });
    expect((await submit(app, body, "has spaces")).status).toBe(400);
  });

  test("400 for invalid payloads: JSON number money, OPENING, reference rules, zero WIN, malformed JSON", async () => {
    const { wallet, providerId } = await fundedWallet();
    const valid = wagerBody({ providerId, wallet, kind: "BET", amount: "1.00" });
    const invalid = [
      { ...valid, money: { amount: 1, currency: "BRL" } },
      { ...valid, kind: "OPENING" },
      { ...valid, referenceExternalTransactionId: "bet-ref" },
      wagerBody({ providerId, wallet, kind: "REFUND", amount: "1.00" }),
      wagerBody({ providerId, wallet, kind: "WIN", amount: "0.00" }),
      { ...valid, providerId: "_system" },
      { ...valid, walletId: "wallet-1" },
    ];
    for (const body of invalid) {
      const response = await submit(app, body, newId());
      expect(response.status).toBe(400);
      expect(response.body.code).toBe("VALIDATION_FAILED");
    }
    const malformed = await app.request("POST", "/wagering/transactions", {
      body: "{not json",
      headers: { "Idempotency-Key": newId() },
    });
    expect(malformed.status).toBe(400);
    expect(malformed.body.code).toBe("VALIDATION_FAILED");
  });

  test("409 for an idempotency key reused with another payload, and for an external id under another key", async () => {
    const { wallet, providerId } = await fundedWallet();
    const body = wagerBody({ providerId, wallet, kind: "BET", amount: "1.00" });
    await submit(app, body);
    const conflict = await submit(app, { ...body, money: { amount: "2.00", currency: "BRL" } });
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe("IDEMPOTENCY_KEY_CONFLICT");
    const external = await submit(app, body, `${providerId}:another-key`);
    expect(external.status).toBe(409);
    expect(external.body.code).toBe("EXTERNAL_TRANSACTION_CONFLICT");
  });

  test("422 WALLET_NOT_FOUND for an unknown wallet in the body", async () => {
    const { wallet, providerId } = await fundedWallet();
    const response = await submit(
      app,
      wagerBody({ providerId, wallet: { ...wallet, id: newId() }, kind: "BET", amount: "1.00" }),
    );
    expect(response.status).toBe(422);
    expect(response.body.code).toBe("WALLET_NOT_FOUND");
  });

  test("503 with Retry-After when the wallet lock cannot be acquired in time; nothing is recorded", async () => {
    const { wallet, providerId } = await fundedWallet();
    const body = wagerBody({ providerId, wallet, kind: "BET", amount: "1.00" });
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked: () => void = () => {};
    const lockHeld = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const holder = sql.begin(async (tx) => {
      await tx`SELECT id FROM wallets WHERE id = ${wallet.id} FOR UPDATE`;
      locked();
      await released;
    });
    try {
      await lockHeld;
      const response = await submit(app, body);
      expect(response.status).toBe(503);
      expect(response.headers.get("retry-after")).toBe("1");
      expect(response.body.code).toBe("SERVICE_UNAVAILABLE");
    } finally {
      release();
      await holder;
    }
    const retried = await submit(app, body);
    expect(retried.status).toBe(201);
    expect(retried.body.idempotentReplay).toBe(false);
  });
});

describe("transaction queries", () => {
  test("by id and by provider external id: 200 view, 400 malformed, 404 unknown", async () => {
    const { wallet, providerId } = await fundedWallet();
    const body = wagerBody({ providerId, wallet, kind: "BET", amount: "3.00" });
    const submitted = await submit(app, body);
    const byId = await app.request("GET", `/wagering/transactions/${submitted.body.transactionId}`);
    expect(byId.status).toBe(200);
    expect(byId.body).toEqual({
      transactionId: submitted.body.transactionId,
      status: "PROCESSED",
      balance: { amount: "97.00", currency: "BRL" },
      providerId,
      externalTransactionId: body.externalTransactionId,
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: "round-1",
      gameId: "fortune-chimp",
      kind: "BET",
      money: { amount: "3.00", currency: "BRL" },
      createdAt: expect.any(String),
      processedAt: expect.any(String),
    });
    const byExternal = await app.request(
      "GET",
      `/providers/${providerId}/wagering/transactions/${body.externalTransactionId}`,
    );
    expect(byExternal.body).toEqual(byId.body);

    expect((await app.request("GET", "/wagering/transactions/not-a-uuid")).status).toBe(400);
    expect((await app.request("GET", `/wagering/transactions/${newId()}`)).status).toBe(404);
    expect((await app.request("GET", `/providers/${providerId}/wagering/transactions/unknown`)).body.code).toBe(
      "TRANSACTION_NOT_FOUND",
    );
    expect((await app.request("GET", `/providers/_system/wagering/transactions/x`)).status).toBe(400);
  });

  test("events carry the request's correlation id and its request id as causation", async () => {
    const { wallet, providerId } = await fundedWallet();
    const correlationId = `corr-${newId()}`;
    const response = await app.request("POST", "/wagering/transactions", {
      body: wagerBody({ providerId, wallet, kind: "BET", amount: "1.00" }),
      headers: { "Idempotency-Key": newId(), "X-Correlation-Id": correlationId },
    });
    expect(response.headers.get("x-correlation-id")).toBe(correlationId);
    const events = await sql`SELECT payload FROM outbox_messages WHERE payload->>'correlationId' = ${correlationId}`;
    expect(events).toHaveLength(2);
    for (const { payload } of events) {
      expect(payload.causationId).toBe(response.headers.get("x-request-id"));
    }
  });
});

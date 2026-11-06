import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startTestApp, type TestApp } from "../../support/test-app";
import { createWallet, newId, newProviderId, submit, wagerBody } from "../../support/wagering-requests";
import { checkWalletsAfterEach } from "../../support/wallet-consistency";

/** T-I7: the wallet endpoints of the spec 3.13 table. */
let app: TestApp;
const touchedWallets = checkWalletsAfterEach();

beforeAll(async () => {
  app = await startTestApp();
});

afterAll(async () => {
  await app.close();
});

describe("POST /wallets", () => {
  test("201 with the contract shape; a positive balance starts at version 1", async () => {
    const playerId = newId();
    const response = await app.request("POST", "/wallets", {
      body: { playerId, initialBalance: { amount: "1000.00", currency: "BRL" } },
    });
    touchedWallets.add(response.body.id);
    expect(response.status).toBe(201);
    expect(response.body).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      playerId,
      balance: { amount: "1000.00", currency: "BRL" },
      version: 1,
    });
  });

  test("400 for a JSON number, a third decimal, a lowercase currency or a bad player id", async () => {
    const invalid = [
      { playerId: newId(), initialBalance: { amount: 1000, currency: "BRL" } },
      { playerId: newId(), initialBalance: { amount: "1.005", currency: "BRL" } },
      { playerId: newId(), initialBalance: { amount: "1.00", currency: "brl" } },
      { playerId: "player-1", initialBalance: { amount: "1.00", currency: "BRL" } },
    ];
    for (const body of invalid) {
      const response = await app.request("POST", "/wallets", { body });
      expect(response.status).toBe(400);
      expect(response.body.code).toBe("VALIDATION_FAILED");
      expect(response.body.details.length).toBeGreaterThan(0);
    }
  });

  test("409 WALLET_ALREADY_EXISTS with the existing wallet id; another currency is a different wallet", async () => {
    const wallet = await createWallet(app, "10.00");
    touchedWallets.add(wallet.id);
    const duplicate = await app.request("POST", "/wallets", {
      body: { playerId: wallet.playerId, initialBalance: { amount: "0.00", currency: "BRL" } },
    });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body).toMatchObject({ code: "WALLET_ALREADY_EXISTS", details: { walletId: wallet.id } });

    const dollars = await app.request("POST", "/wallets", {
      body: { playerId: wallet.playerId, initialBalance: { amount: "0.00", currency: "USD" } },
    });
    touchedWallets.add(dollars.body.id);
    expect(dollars.status).toBe(201);
  });
});

describe("GET /wallets/:walletId", () => {
  test("200, 400 for a malformed id, 404 for an unknown one", async () => {
    const wallet = await createWallet(app, "15.50");
    touchedWallets.add(wallet.id);
    const found = await app.request("GET", `/wallets/${wallet.id.toUpperCase()}`);
    expect(found.status).toBe(200);
    expect(found.body).toEqual({
      id: wallet.id,
      playerId: wallet.playerId,
      balance: { amount: "15.50", currency: "BRL" },
      version: 1,
    });
    expect((await app.request("GET", "/wallets/not-a-uuid")).status).toBe(400);
    const missing = await app.request("GET", `/wallets/${newId()}`);
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe("WALLET_NOT_FOUND");
  });
});

describe("GET /wallets/:walletId/ledger", () => {
  test("newest first, with a cursor that stays stable while entries are appended", async () => {
    const wallet = await createWallet(app, "100.00");
    touchedWallets.add(wallet.id);
    const providerId = newProviderId();
    for (let bet = 0; bet < 3; bet += 1) {
      await submit(app, wagerBody({ providerId, wallet, kind: "BET", amount: "1.00" }));
    }
    const first = await app.request("GET", `/wallets/${wallet.id}/ledger?limit=2`);
    expect(first.status).toBe(200);
    expect(first.body.items.map((item: { walletVersion: number }) => item.walletVersion)).toEqual([4, 3]);
    expect(first.body.items[0]).toEqual({
      id: expect.any(String),
      transactionId: expect.any(String),
      direction: "DEBIT",
      money: { amount: "1.00", currency: "BRL" },
      balanceBefore: { amount: "98.00", currency: "BRL" },
      balanceAfter: { amount: "97.00", currency: "BRL" },
      walletVersion: 4,
      createdAt: expect.any(String),
    });

    await submit(app, wagerBody({ providerId, wallet, kind: "WIN", amount: "5.00" }));
    const second = await app.request("GET", `/wallets/${wallet.id}/ledger?limit=2&cursor=${first.body.nextCursor}`);
    expect(second.body.items.map((item: { walletVersion: number }) => item.walletVersion)).toEqual([2, 1]);
    expect(second.body.nextCursor).toBeNull();
  });

  test("400 for a bad cursor or limit, 404 for an unknown wallet", async () => {
    const wallet = await createWallet(app, "1.00");
    touchedWallets.add(wallet.id);
    expect((await app.request("GET", `/wallets/${wallet.id}/ledger?cursor=garbage`)).status).toBe(400);
    expect((await app.request("GET", `/wallets/${wallet.id}/ledger?limit=0`)).status).toBe(400);
    expect((await app.request("GET", `/wallets/${wallet.id}/ledger?limit=201`)).status).toBe(400);
    expect((await app.request("GET", `/wallets/${newId()}/ledger`)).status).toBe(404);
  });
});

describe("POST /wallets/:walletId/reconciliation", () => {
  test("200 consistent, 400 for a malformed id, 404 for an unknown one", async () => {
    const wallet = await createWallet(app, "42.00");
    touchedWallets.add(wallet.id);
    const response = await app.request("POST", `/wallets/${wallet.id}/reconciliation`);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      walletId: wallet.id,
      storedBalance: { amount: "42.00", currency: "BRL" },
      calculatedBalance: { amount: "42.00", currency: "BRL" },
      difference: { amount: "0.00", currency: "BRL" },
      consistent: true,
      checkedEntries: 1,
    });
    expect((await app.request("POST", "/wallets/nope/reconciliation")).status).toBe(400);
    expect((await app.request("POST", `/wallets/${newId()}/reconciliation`)).status).toBe(404);
  });
});

describe("edge endpoints", () => {
  test("GET /health/ready reports PostgreSQL and SQS", async () => {
    const response = await app.request("GET", "/health/ready");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ok", checks: { postgres: "ok", sqs: "ok" } });
  });

  test("an unknown route is a 404 with a machine-readable code", async () => {
    const response = await app.request("GET", "/nowhere");
    expect(response.status).toBe(404);
    expect(response.body.code).toBe("ROUTE_NOT_FOUND");
  });
});

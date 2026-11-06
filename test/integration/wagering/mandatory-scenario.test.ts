import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startTestApp, type TestApp } from "../../support/test-app";
import { createWallet, newProviderId, submit, wagerBody } from "../../support/wagering-requests";
import { checkWalletsAfterEach, debitCount } from "../../support/wallet-consistency";

/**
 * Challenge section 8, in process: requests race over real HTTP connections and real PostgreSQL row locks. The
 * multi-process versions belong to the concurrency suite (T-C1, T-C2).
 */
let app: TestApp;
const touchedWallets = checkWalletsAfterEach();

beforeAll(async () => {
  app = await startTestApp();
});

afterAll(async () => {
  await app.close();
});

describe("concurrent bets on one wallet", () => {
  test("100.00 BRL and two 80.00 bets at once: one PROCESSED, one INSUFFICIENT_FUNDS, 20.00, one debit", async () => {
    const wallet = await createWallet(app, "100.00");
    touchedWallets.add(wallet.id);
    const providerId = newProviderId();
    const bets = [1, 2].map(() => wagerBody({ providerId, wallet, kind: "BET", amount: "80.00" }));

    const responses = await Promise.all(bets.map((bet) => submit(app, bet)));
    const outcomes = responses.map((response) =>
      `${response.status} ${response.body.status} ${response.body.failureCode ?? ""}`.trim(),
    );
    expect(outcomes.sort()).toEqual(["201 PROCESSED", "422 REJECTED INSUFFICIENT_FUNDS"]);
    expect((await app.request("GET", `/wallets/${wallet.id}`)).body.balance).toEqual({
      amount: "20.00",
      currency: "BRL",
    });
    expect(await debitCount(wallet.id)).toBe(1);

    const resent = await Promise.all(bets.map((bet) => submit(app, bet)));
    expect(resent.map((response) => response.body.idempotentReplay)).toEqual([true, true]);
    expect(resent.map((response) => response.body.status)).toEqual(responses.map((response) => response.body.status));
    expect((await app.request("GET", `/wallets/${wallet.id}`)).body).toMatchObject({
      balance: { amount: "20.00" },
      version: 2,
    });
    expect(await debitCount(wallet.id)).toBe(1);
  });

  test("the same bet 50 times in parallel debits once; every other answer is a replay", async () => {
    const wallet = await createWallet(app, "100.00");
    touchedWallets.add(wallet.id);
    const bet = wagerBody({ providerId: newProviderId(), wallet, kind: "BET", amount: "10.00" });
    const responses = await Promise.all(Array.from({ length: 50 }, () => submit(app, bet)));
    expect(new Set(responses.map((response) => response.status))).toEqual(new Set([201]));
    expect(new Set(responses.map((response) => response.body.transactionId)).size).toBe(1);
    expect(responses.filter((response) => !response.body.idempotentReplay)).toHaveLength(1);
    expect(await debitCount(wallet.id)).toBe(1);
  });

  test("20 distinct 10.00 bets on 100.00: exactly 10 processed, 10 rejected, final 0.00", async () => {
    const wallet = await createWallet(app, "100.00");
    touchedWallets.add(wallet.id);
    const providerId = newProviderId();
    const responses = await Promise.all(
      Array.from({ length: 20 }, () => submit(app, wagerBody({ providerId, wallet, kind: "BET", amount: "10.00" }))),
    );
    expect(responses.filter((response) => response.status === 201)).toHaveLength(10);
    expect(responses.filter((response) => response.body.failureCode === "INSUFFICIENT_FUNDS")).toHaveLength(10);
    expect((await app.request("GET", `/wallets/${wallet.id}`)).body.balance).toEqual({
      amount: "0.00",
      currency: "BRL",
    });
  });
});

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type Instances, spawnInstances } from "../support/instances";
import { createWallet, newProviderId, submit, wagerBody } from "../support/wagering-requests";
import { checkWalletsAfterEach, debitCount } from "../support/wallet-consistency";

/** T-C2 (HTTP): challenge section 8 with the two bets racing in separate application processes. */
let instances: Instances;
const touchedWallets = checkWalletsAfterEach();

beforeAll(async () => {
  instances = await spawnInstances(3);
}, 60_000);

afterAll(async () => {
  await instances?.close();
});

describe("challenge section 8 across 3 processes", () => {
  test("100.00 BRL and two 80.00 bets at once: one PROCESSED, one INSUFFICIENT_FUNDS, 20.00, one debit", async () => {
    const wallet = await createWallet(instances.pick(0), "100.00");
    touchedWallets.add(wallet.id);
    const providerId = newProviderId();
    const bets = [0, 1].map(() => wagerBody({ providerId, wallet, kind: "BET", amount: "80.00" }));

    const responses = await Promise.all(bets.map((bet, index) => submit(instances.pick(index), bet)));
    const outcomes = responses.map((response) =>
      `${response.status} ${response.body.status} ${response.body.failureCode ?? ""}`.trim(),
    );
    expect(outcomes.sort()).toEqual(["201 PROCESSED", "422 REJECTED INSUFFICIENT_FUNDS"]);

    const resent = await Promise.all(bets.map((bet, index) => submit(instances.pick(index + 2), bet)));
    expect(resent.map((response) => response.body)).toEqual(
      responses.map((response) => ({ ...response.body, idempotentReplay: true })),
    );

    expect((await instances.pick(2).request("GET", `/wallets/${wallet.id}`)).body).toMatchObject({
      balance: { amount: "20.00", currency: "BRL" },
      version: 2,
    });
    expect(await debitCount(wallet.id)).toBe(1);
  });
});

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type Instances, spawnInstances } from "../support/instances";
import { createWallet, newProviderId, submit, wagerBody } from "../support/wagering-requests";
import { checkWalletsAfterEach, debitCount } from "../support/wallet-consistency";

/** T-C1 (HTTP): one bet with one Idempotency-Key, 50 times in parallel spread over separate application processes. */
let instances: Instances;
const touchedWallets = checkWalletsAfterEach();

beforeAll(async () => {
  instances = await spawnInstances(3);
}, 60_000);

afterAll(async () => {
  await instances?.close();
});

describe("the same bet 50 times across 3 processes", () => {
  test("debits once; every other answer is a replay of the original result", async () => {
    const wallet = await createWallet(instances.pick(0), "100.00");
    touchedWallets.add(wallet.id);
    const bet = wagerBody({ providerId: newProviderId(), wallet, kind: "BET", amount: "10.00" });

    const responses = await Promise.all(Array.from({ length: 50 }, (_, index) => submit(instances.pick(index), bet)));
    const originals = responses.filter((response) => !response.body.idempotentReplay);
    expect(originals).toHaveLength(1);
    const original = originals[0]?.body;
    expect(original).toMatchObject({ status: "PROCESSED", balance: { amount: "90.00", currency: "BRL" } });
    for (const response of responses) {
      expect(response.status).toBe(201);
      expect(response.body).toEqual({ ...original, idempotentReplay: response.body.idempotentReplay });
    }

    expect((await instances.pick(1).request("GET", `/wallets/${wallet.id}`)).body.balance).toEqual({
      amount: "90.00",
      currency: "BRL",
    });
    expect(await debitCount(wallet.id)).toBe(1);
  });
});

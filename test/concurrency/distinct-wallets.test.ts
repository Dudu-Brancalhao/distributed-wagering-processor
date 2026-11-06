import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type Instances, spawnInstances } from "../support/instances";
import { createWallet, newProviderId, submit, wagerBody } from "../support/wagering-requests";
import { checkWalletsAfterEach, debitCount } from "../support/wallet-consistency";

/** T-C3 (HTTP): distinct wallets processed in parallel, each wallet's bets spread over separate application processes. */
let instances: Instances;
const touchedWallets = checkWalletsAfterEach();

beforeAll(async () => {
  instances = await spawnInstances(3);
}, 60_000);

afterAll(async () => {
  await instances?.close();
});

/** Concurrent 10.00 bets per 100.00 wallet; the last two wallets are oversubscribed and must stop at 0.00. */
const WALLET_PLANS = [
  { bets: 3, processed: 3, balance: "70.00" },
  { bets: 5, processed: 5, balance: "50.00" },
  { bets: 8, processed: 8, balance: "20.00" },
  { bets: 10, processed: 10, balance: "0.00" },
  { bets: 12, processed: 10, balance: "0.00" },
] as const;

const outcomeOf = (response: { status: number; body: Record<string, unknown> }): string =>
  `${response.status} ${response.body.status} ${response.body.failureCode ?? ""}`.trim();

describe("distinct wallets in parallel across 3 processes", () => {
  test("every wallet ends with its own expected balance, version and debits", async () => {
    const providerId = newProviderId();
    const plans = await Promise.all(
      WALLET_PLANS.map(async (plan, index) => ({
        ...plan,
        wallet: await createWallet(instances.pick(index), "100.00"),
      })),
    );
    for (const plan of plans) touchedWallets.add(plan.wallet.id);

    const bets = plans.flatMap((plan) =>
      Array.from({ length: plan.bets }, () => ({
        walletId: plan.wallet.id,
        body: wagerBody({ providerId, wallet: plan.wallet, kind: "BET", amount: "10.00" }),
      })),
    );
    const results = await Promise.all(
      bets.map(async (bet, index) => ({
        walletId: bet.walletId,
        outcome: outcomeOf(await submit(instances.pick(index), bet.body)),
      })),
    );

    for (const [index, plan] of plans.entries()) {
      const outcomes = results.filter((result) => result.walletId === plan.wallet.id).map((result) => result.outcome);
      expect(outcomes.filter((outcome) => outcome === "201 PROCESSED")).toHaveLength(plan.processed);
      expect(outcomes.filter((outcome) => outcome === "422 REJECTED INSUFFICIENT_FUNDS")).toHaveLength(
        plan.bets - plan.processed,
      );
      expect((await instances.pick(index + 1).request("GET", `/wallets/${plan.wallet.id}`)).body).toMatchObject({
        balance: { amount: plan.balance, currency: "BRL" },
        version: 1 + plan.processed,
      });
      expect(await debitCount(plan.wallet.id)).toBe(plan.processed);
    }
  });
});

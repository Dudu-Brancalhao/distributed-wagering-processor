import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "../../support/sql";
import { startTestApp, type TestApp } from "../../support/test-app";
import { createWallet, newProviderId, submit, wagerBody } from "../../support/wagering-requests";
import { checkWalletsAfterEach } from "../../support/wallet-consistency";

/** T-I8: divergences are reported, logged and counted, never corrected. */
let app: TestApp;
const touchedWallets = checkWalletsAfterEach();

beforeAll(async () => {
  app = await startTestApp();
});

afterAll(async () => {
  await app.close();
});

/** Bypasses every guard trigger, as only a superuser repairing data by hand could. */
async function forceBalance(walletId: string, balance: string): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`ALTER TABLE wallets DISABLE TRIGGER ALL`;
    await tx`UPDATE wallets SET balance = ${balance}::numeric WHERE id = ${walletId}`;
    await tx`ALTER TABLE wallets ENABLE TRIGGER ALL`;
  });
}

async function divergenceCount(): Promise<number> {
  const metrics = await (await fetch(`${app.baseUrl}/metrics`)).text();
  const line = metrics.split("\n").find((entry) => entry.startsWith("wagering_reconciliation_divergences_total"));
  return line ? Number(line.split(" ").at(-1)) : 0;
}

describe("POST /wallets/:walletId/reconciliation", () => {
  test("a consistent wallet after several movements", async () => {
    const wallet = await createWallet(app, "100.00");
    touchedWallets.add(wallet.id);
    const providerId = newProviderId();
    await submit(app, wagerBody({ providerId, wallet, kind: "BET", amount: "40.00" }));
    await submit(app, wagerBody({ providerId, wallet, kind: "WIN", amount: "15.25" }));
    const response = await app.request("POST", `/wallets/${wallet.id}/reconciliation`);
    expect(response.body).toMatchObject({
      storedBalance: { amount: "75.25", currency: "BRL" },
      calculatedBalance: { amount: "75.25", currency: "BRL" },
      difference: { amount: "0.00", currency: "BRL" },
      consistent: true,
      checkedEntries: 3,
    });
  });

  test("an induced divergence is flagged, logged and counted, and stays uncorrected", async () => {
    const wallet = await createWallet(app, "100.00");
    touchedWallets.add(wallet.id);
    const countBefore = await divergenceCount();
    await forceBalance(wallet.id, "90.00");
    try {
      const first = await app.request("POST", `/wallets/${wallet.id}/reconciliation`);
      expect(first.status).toBe(200);
      expect(first.body).toEqual({
        walletId: wallet.id,
        storedBalance: { amount: "90.00", currency: "BRL" },
        calculatedBalance: { amount: "100.00", currency: "BRL" },
        difference: { amount: "-10.00", currency: "BRL" },
        consistent: false,
        checkedEntries: 1,
      });
      const second = await app.request("POST", `/wallets/${wallet.id}/reconciliation`);
      expect(second.body).toEqual(first.body);
      expect(await divergenceCount()).toBe(countBefore + 2);
      const logged = app.logLines
        .map((line) => JSON.parse(line))
        .filter((entry) => entry.event === "reconciliation.divergence" && entry.walletId === wallet.id);
      expect(logged).toHaveLength(2);
      expect(JSON.stringify(logged)).not.toContain("90.00");
    } finally {
      await forceBalance(wallet.id, "100.00");
    }
  });
});

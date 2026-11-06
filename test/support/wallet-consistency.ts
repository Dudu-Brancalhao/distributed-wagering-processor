import { afterEach, expect } from "bun:test";
import { sql } from "./sql";

interface LedgerRow {
  readonly wallet_version: number;
  readonly direction: string;
  readonly amount: string;
  readonly balance_before: string;
  readonly balance_after: string;
}

/**
 * The final invariant of every wallet-touching test (R-64, spec 3.21): balance equals the ledger sum, versions are
 * contiguous up to the wallet version, the chain links, and there is one entry per processed balance-moving
 * transaction. Amounts are compared by PostgreSQL as numeric, never as JavaScript numbers.
 */
export async function expectWalletConsistent(walletId: string): Promise<void> {
  const [wallet] = await sql`
    SELECT w.version,
           w.balance = COALESCE(SUM(CASE e.direction WHEN 'CREDIT' THEN e.amount ELSE -e.amount END), 0) AS balanced
    FROM wallets w LEFT JOIN wallet_ledger_entries e ON e.wallet_id = w.id
    WHERE w.id = ${walletId}
    GROUP BY w.id`;
  expect(wallet).toBeDefined();
  expect(wallet.balanced).toBe(true);

  const entries: LedgerRow[] = await sql`
    SELECT wallet_version, direction, amount::text, balance_before::text, balance_after::text
    FROM wallet_ledger_entries WHERE wallet_id = ${walletId} ORDER BY wallet_version`;
  const [{ count: openings }] = await sql`
    SELECT COUNT(*)::int AS count FROM wager_transactions WHERE wallet_id = ${walletId} AND kind = 'OPENING'`;
  const firstVersion = openings === 1 ? 1 : 2;
  expect(entries.map((entry) => entry.wallet_version)).toEqual(
    Array.from({ length: wallet.version - firstVersion + 1 }, (_, index) => firstVersion + index),
  );
  entries.forEach((entry, index) => {
    expect(entry.balance_before).toBe(index === 0 ? "0.00" : (entries[index - 1]?.balance_after ?? ""));
  });

  const [{ count: movingTransactions }] = await sql`
    SELECT COUNT(*)::int AS count FROM wager_transactions
    WHERE wallet_id = ${walletId} AND status = 'PROCESSED' AND kind <> 'LOSS'`;
  expect(entries.length).toBe(movingTransactions);
}

/** Registers the final invariant for every wallet a test adds to the returned set. */
export function checkWalletsAfterEach(): Set<string> {
  const touched = new Set<string>();
  afterEach(async () => {
    for (const walletId of touched) {
      await expectWalletConsistent(walletId);
    }
    touched.clear();
  });
  return touched;
}

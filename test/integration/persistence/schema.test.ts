import { describe, expect, test } from "bun:test";
import { MikroORM } from "@mikro-orm/postgresql";
import { SQL, type TransactionSQL } from "bun";
import { mikroOrmOptions } from "../../../src/infrastructure/persistence/mikro-orm.config";
import { sql, sqlStateOf } from "../../support/sql";
import { TEST_DATABASE_URL, testConfig } from "../../support/test-config";
import { newId } from "../../support/wagering-requests";

/** T-I1: every guarantee of spec 3.10 is enforced by PostgreSQL itself, with the documented SQLSTATE. */
const RESTRICT_VIOLATION = "23001";
const DEFERRED_LEDGER_CHECK = "23000";
const CHECK_VIOLATION = "23514";
const UNIQUE_VIOLATION = "23505";
const FOREIGN_KEY_VIOLATION = "23503";

interface FundedWallet {
  readonly walletId: string;
  readonly playerId: string;
  readonly openingId: string;
  readonly entryId: string;
}

const now = new Date();

function transactionRow(wallet: { walletId: string; playerId: string }, fields: Record<string, unknown> = {}) {
  return {
    id: newId(),
    provider_id: "provider-schema",
    external_transaction_id: newId(),
    idempotency_key: newId(),
    payload_hash: "a".repeat(64),
    correlation_id: "corr-schema",
    wallet_id: wallet.walletId,
    player_id: wallet.playerId,
    round_id: "round-1",
    game_id: "game-1",
    kind: "LOSS",
    amount: "0.00",
    currency: "BRL",
    status: "PROCESSED",
    observed_balance: "100.00",
    observed_currency: "BRL",
    observed_wallet_version: 1,
    created_at: now,
    updated_at: now,
    processed_at: now,
    ...fields,
  };
}

function ledgerRow(fields: Record<string, unknown>) {
  return { id: newId(), direction: "CREDIT", currency: "BRL", created_at: now, ...fields };
}

/** A wallet opened with 100.00 BRL: wallet, OPENING transaction and its CREDIT entry, committed together. */
async function fundedWallet(): Promise<FundedWallet> {
  const walletId = newId();
  const playerId = newId();
  const openingId = newId();
  const entryId = newId();
  await sql.begin(async (tx) => {
    await tx`INSERT INTO wallets ${tx({ id: walletId, player_id: playerId, currency: "BRL", balance: "100.00", version: 1, created_at: now, updated_at: now })}`;
    await tx`INSERT INTO wager_transactions ${tx(
      transactionRow(
        { walletId, playerId },
        { id: openingId, provider_id: "_system", kind: "OPENING", amount: "100.00" },
      ),
    )}`;
    await tx`INSERT INTO wallet_ledger_entries ${tx(
      ledgerRow({
        id: entryId,
        wallet_id: walletId,
        transaction_id: openingId,
        wallet_version: 1,
        amount: "100.00",
        balance_before: "0.00",
        balance_after: "100.00",
      }),
    )}`;
  });
  return { walletId, playerId, openingId, entryId };
}

/** Runs statements in one SQL transaction and returns the SQLSTATE that aborted it (at a statement or at COMMIT). */
function failureOf(work: (tx: TransactionSQL) => Promise<unknown>): Promise<string | undefined> {
  return sqlStateOf(sql.begin(work));
}

/** Debits 10.00 from a funded wallet: the BET row, its entry at version 2 and the wallet update. */
async function debitTen(tx: TransactionSQL, wallet: FundedWallet, entry: Record<string, unknown> = {}) {
  const bet = transactionRow(wallet, {
    kind: "BET",
    amount: "10.00",
    observed_balance: "90.00",
    observed_wallet_version: 2,
  });
  await tx`INSERT INTO wager_transactions ${tx(bet)}`;
  await tx`INSERT INTO wallet_ledger_entries ${tx(
    ledgerRow({
      wallet_id: wallet.walletId,
      transaction_id: bet.id,
      wallet_version: 2,
      direction: "DEBIT",
      amount: "10.00",
      balance_before: "100.00",
      balance_after: "90.00",
      ...entry,
    }),
  )}`;
  await tx`UPDATE wallets SET balance = 90.00, version = 2 WHERE id = ${wallet.walletId}`;
  return bet;
}

describe("migrations", () => {
  test("run up, down and up again on an empty database", async () => {
    const database = `wagering_migrations_${newId().replaceAll("-", "").slice(-12)}`;
    await sql.unsafe(`CREATE DATABASE ${database}`);
    const url = new URL(TEST_DATABASE_URL);
    url.pathname = `/${database}`;
    const orm = await MikroORM.init(mikroOrmOptions(testConfig({ DATABASE_URL: url.toString() })));
    const target = new SQL(url.toString());
    const tables = async () =>
      (
        await target`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'mikro_orm_migrations' ORDER BY tablename`
      ).map((row: { tablename: string }) => row.tablename);
    try {
      await orm.migrator.up();
      expect(await tables()).toEqual([
        "inbox_messages",
        "outbox_messages",
        "wager_transactions",
        "wallet_ledger_entries",
        "wallets",
      ]);
      await orm.migrator.down();
      expect(await tables()).toEqual([]);
      const [{ count }] =
        await target`SELECT COUNT(*)::int AS count FROM pg_proc WHERE proname IN ('forbid_mutation', 'guard_wallet_update', 'guard_wager_transaction_update', 'assert_balance_change_has_ledger_entry', 'assert_ledger_entry_applied_to_wallet')`;
      expect(count).toBe(0);
      await orm.migrator.up();
      expect(await tables()).toHaveLength(5);
    } finally {
      await target.close();
      await orm.close();
      await sql.unsafe(`DROP DATABASE ${database}`);
    }
  });
});

describe("append-only ledger", () => {
  test("UPDATE, DELETE and TRUNCATE are forbidden", async () => {
    const { entryId } = await fundedWallet();
    expect(await sqlStateOf(sql`UPDATE wallet_ledger_entries SET created_at = now() WHERE id = ${entryId}`)).toBe(
      RESTRICT_VIOLATION,
    );
    expect(await sqlStateOf(sql`DELETE FROM wallet_ledger_entries WHERE id = ${entryId}`)).toBe(RESTRICT_VIOLATION);
    expect(await sqlStateOf(sql`TRUNCATE wallet_ledger_entries`)).toBe(RESTRICT_VIOLATION);
  });

  test("an entry must balance and move a positive amount", async () => {
    const wallet = await fundedWallet();
    const unbalanced = failureOf((tx) => debitTen(tx, wallet, { balance_after: "80.00" }));
    expect(await unbalanced).toBe(CHECK_VIOLATION);
  });
});

describe("wallets", () => {
  test("a negative balance is rejected", async () => {
    const insert = sql`INSERT INTO wallets ${sql({ id: newId(), player_id: newId(), currency: "BRL", balance: "-1.00", version: 1, created_at: now, updated_at: now })}`;
    expect(await sqlStateOf(insert)).toBe(CHECK_VIOLATION);
  });

  test("one wallet per player and currency", async () => {
    const { playerId } = await fundedWallet();
    const duplicate = sql`INSERT INTO wallets ${sql({ id: newId(), player_id: playerId, currency: "BRL", balance: "0.00", version: 1, created_at: now, updated_at: now })}`;
    expect(await sqlStateOf(duplicate)).toBe(UNIQUE_VIOLATION);
  });

  test("the version guard: +1 exactly with a balance change, never alone; identity is immutable; no deletes", async () => {
    const { walletId } = await fundedWallet();
    expect(await sqlStateOf(sql`UPDATE wallets SET balance = 90.00, version = 3 WHERE id = ${walletId}`)).toBe(
      RESTRICT_VIOLATION,
    );
    expect(await sqlStateOf(sql`UPDATE wallets SET version = 2 WHERE id = ${walletId}`)).toBe(RESTRICT_VIOLATION);
    expect(await sqlStateOf(sql`UPDATE wallets SET currency = 'USD' WHERE id = ${walletId}`)).toBe(RESTRICT_VIOLATION);
    expect(await sqlStateOf(sql`DELETE FROM wallets WHERE id = ${walletId}`)).toBe(RESTRICT_VIOLATION);
  });
});

describe("deferred balance and ledger checks (at COMMIT)", () => {
  test("a balance change without its ledger entry fails", async () => {
    const { walletId } = await fundedWallet();
    expect(await failureOf((tx) => tx`UPDATE wallets SET balance = 90.00, version = 2 WHERE id = ${walletId}`)).toBe(
      DEFERRED_LEDGER_CHECK,
    );
  });

  test("an entry with the wrong balance_before fails", async () => {
    const wallet = await fundedWallet();
    const failure = failureOf((tx) => debitTen(tx, wallet, { balance_before: "95.00", balance_after: "85.00" }));
    expect(await failure).toBe(DEFERRED_LEDGER_CHECK);
  });

  test("an entry without the matching balance change fails", async () => {
    const wallet = await fundedWallet();
    const failure = failureOf(async (tx) => {
      const bet = transactionRow(wallet, { kind: "BET", amount: "10.00" });
      await tx`INSERT INTO wager_transactions ${tx(bet)}`;
      await tx`INSERT INTO wallet_ledger_entries ${tx(
        ledgerRow({
          wallet_id: wallet.walletId,
          transaction_id: bet.id,
          wallet_version: 2,
          direction: "DEBIT",
          amount: "10.00",
          balance_before: "100.00",
          balance_after: "90.00",
        }),
      )}`;
    });
    expect(await failure).toBe(DEFERRED_LEDGER_CHECK);
  });

  test("a positive opening balance without its entry fails", async () => {
    const failure = failureOf(
      (tx) =>
        tx`INSERT INTO wallets ${tx({ id: newId(), player_id: newId(), currency: "BRL", balance: "5.00", version: 1, created_at: now, updated_at: now })}`,
    );
    expect(await failure).toBe(DEFERRED_LEDGER_CHECK);
  });

  test("a ledger row inserted before its transaction in the same SQL transaction still commits", async () => {
    const wallet = await fundedWallet();
    const bet = transactionRow(wallet, {
      kind: "BET",
      amount: "10.00",
      observed_balance: "90.00",
      observed_wallet_version: 2,
    });
    await sql.begin(async (tx) => {
      await tx`INSERT INTO wallet_ledger_entries ${tx(
        ledgerRow({
          wallet_id: wallet.walletId,
          transaction_id: bet.id,
          wallet_version: 2,
          direction: "DEBIT",
          amount: "10.00",
          balance_before: "100.00",
          balance_after: "90.00",
        }),
      )}`;
      await tx`INSERT INTO wager_transactions ${tx(bet)}`;
      await tx`UPDATE wallets SET balance = 90.00, version = 2 WHERE id = ${wallet.walletId}`;
    });
    const [{ balance }] = await sql`SELECT balance::text FROM wallets WHERE id = ${wallet.walletId}`;
    expect(balance).toBe("90.00");
  });

  test("the composite foreign keys tie an entry to its transaction's amount and its wallet's currency", async () => {
    const wallet = await fundedWallet();
    expect(await failureOf((tx) => debitTen(tx, wallet, { amount: "10.00", currency: "USD" }))).toBe(
      FOREIGN_KEY_VIOLATION,
    );
    const wrongTransaction = newId();
    expect(await failureOf((tx) => debitTen(tx, wallet, { transaction_id: wrongTransaction }))).toBe(
      FOREIGN_KEY_VIOLATION,
    );
  });

  test("one entry per transaction per wallet", async () => {
    const wallet = await fundedWallet();
    const failure = failureOf(async (tx) => {
      const bet = await debitTen(tx, wallet);
      await tx`INSERT INTO wallet_ledger_entries ${tx(
        ledgerRow({
          wallet_id: wallet.walletId,
          transaction_id: bet.id,
          wallet_version: 3,
          direction: "DEBIT",
          amount: "10.00",
          balance_before: "90.00",
          balance_after: "80.00",
        }),
      )}`;
    });
    expect(await failure).toBe(UNIQUE_VIOLATION);
  });
});

describe("wager transactions", () => {
  test("idempotency key and external id are unique per provider", async () => {
    const wallet = await fundedWallet();
    const original = transactionRow(wallet);
    await sql`INSERT INTO wager_transactions ${sql(original)}`;
    const sameKey = transactionRow(wallet, { idempotency_key: original.idempotency_key });
    const sameExternal = transactionRow(wallet, { external_transaction_id: original.external_transaction_id });
    expect(await sqlStateOf(sql`INSERT INTO wager_transactions ${sql(sameKey)}`)).toBe(UNIQUE_VIOLATION);
    expect(await sqlStateOf(sql`INSERT INTO wager_transactions ${sql(sameExternal)}`)).toBe(UNIQUE_VIOLATION);
  });

  test("OPENING is reserved to _system and happens once per wallet", async () => {
    const wallet = await fundedWallet();
    const secondOpening = transactionRow(wallet, { provider_id: "_system", kind: "OPENING", amount: "1.00" });
    expect(await sqlStateOf(sql`INSERT INTO wager_transactions ${sql(secondOpening)}`)).toBe(UNIQUE_VIOLATION);
    const providerOpening = transactionRow(wallet, { kind: "OPENING", amount: "1.00" });
    expect(await sqlStateOf(sql`INSERT INTO wager_transactions ${sql(providerOpening)}`)).toBe(CHECK_VIOLATION);
    const systemBet = transactionRow(wallet, { provider_id: "_system", kind: "BET", amount: "1.00" });
    expect(await sqlStateOf(sql`INSERT INTO wager_transactions ${sql(systemBet)}`)).toBe(CHECK_VIOLATION);
  });

  test("a referenced transaction is reversed at most once", async () => {
    const wallet = await fundedWallet();
    const reversal = (kind: string) =>
      transactionRow(wallet, {
        kind,
        amount: "100.00",
        reference_external_transaction_id: "ref",
        reference_transaction_id: wallet.openingId,
      });
    await sql`INSERT INTO wager_transactions ${sql(reversal("ROLLBACK"))}`;
    expect(await sqlStateOf(sql`INSERT INTO wager_transactions ${sql(reversal("REFUND"))}`)).toBe(UNIQUE_VIOLATION);
  });

  test("status-dependent columns stay coherent", async () => {
    const wallet = await fundedWallet();
    const withoutObservation = transactionRow(wallet, {
      observed_balance: null,
      observed_currency: null,
      observed_wallet_version: null,
    });
    expect(await sqlStateOf(sql`INSERT INTO wager_transactions ${sql(withoutObservation)}`)).toBe(CHECK_VIOLATION);
    const rejectedWithoutCode = transactionRow(wallet, { status: "REJECTED", processed_at: null });
    expect(await sqlStateOf(sql`INSERT INTO wager_transactions ${sql(rejectedWithoutCode)}`)).toBe(CHECK_VIOLATION);
    const pendingWithoutSchedule = transactionRow(wallet, {
      kind: "REFUND",
      amount: "1.00",
      reference_external_transaction_id: "ref",
      status: "PENDING_REFERENCE",
      processed_at: null,
    });
    expect(await sqlStateOf(sql`INSERT INTO wager_transactions ${sql(pendingWithoutSchedule)}`)).toBe(CHECK_VIOLATION);
    const refundWithoutReference = transactionRow(wallet, { kind: "REFUND", amount: "1.00" });
    expect(await sqlStateOf(sql`INSERT INTO wager_transactions ${sql(refundWithoutReference)}`)).toBe(CHECK_VIOLATION);
  });

  test("terminal rows are frozen, request columns are immutable and transitions are valid", async () => {
    const wallet = await fundedWallet();
    expect(
      await sqlStateOf(
        sql`UPDATE wager_transactions SET status = 'REJECTED', failure_code = 'X', processed_at = NULL WHERE id = ${wallet.openingId}`,
      ),
    ).toBe(RESTRICT_VIOLATION);
    const pending = transactionRow(wallet, {
      kind: "REFUND",
      amount: "1.00",
      reference_external_transaction_id: "ref",
      status: "PENDING_REFERENCE",
      processed_at: null,
      next_attempt_at: now,
    });
    await sql`INSERT INTO wager_transactions ${sql(pending)}`;
    expect(await sqlStateOf(sql`UPDATE wager_transactions SET amount = 2.00 WHERE id = ${pending.id}`)).toBe(
      RESTRICT_VIOLATION,
    );
    expect(
      await sqlStateOf(
        sql`UPDATE wager_transactions SET status = 'PENDING', next_attempt_at = NULL WHERE id = ${pending.id}`,
      ),
    ).toBe(RESTRICT_VIOLATION);
    expect(await sqlStateOf(sql`DELETE FROM wager_transactions WHERE id = ${pending.id}`)).toBe(RESTRICT_VIOLATION);
    expect(await sqlStateOf(sql`TRUNCATE wager_transactions CASCADE`)).toBe(RESTRICT_VIOLATION);
  });
});

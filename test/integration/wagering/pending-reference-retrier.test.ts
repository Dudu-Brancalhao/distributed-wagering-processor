import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { RetryPendingReferences } from "../../../src/application/wagering/retry-pending-references";
import { eventually } from "../../support/eventually";
import { sql } from "../../support/sql";
import { startTestApp, type TestApp } from "../../support/test-app";
import {
  createWallet,
  newId,
  newProviderId,
  submit,
  type TestWallet,
  wagerBody,
} from "../../support/wagering-requests";
import { checkWalletsAfterEach } from "../../support/wallet-consistency";

/**
 * S-07 (spec 3.16): the pending-reference retrier settles a reversal once its reference arrives, rejects it once the
 * retry window is used up, waits for a busy wallet instead of skipping it, and marks FAILED what retrying cannot fix.
 */
const touchedWallets = checkWalletsAfterEach();

interface OutboxPayload {
  readonly correlationId: string;
  readonly causationId?: string;
  readonly data: { readonly failureCode?: string };
}

interface Scenario {
  readonly providerId: string;
  readonly wallet: TestWallet;
}

async function scenario(app: TestApp, initialBalance = "100.00"): Promise<Scenario> {
  const wallet = await createWallet(app, initialBalance);
  touchedWallets.add(wallet.id);
  return { providerId: newProviderId(), wallet };
}

async function submitOk(app: TestApp, body: ReturnType<typeof wagerBody>, expectedStatus: number) {
  const response = await submit(app, body);
  expect(response.status).toBe(expectedStatus);
  return response.body;
}

function getTransaction(app: TestApp, transactionId: string) {
  return app.request("GET", `/wagering/transactions/${transactionId}`);
}

async function eventTypesOf(transactionId: string): Promise<string[]> {
  const rows: { event_type: string }[] = await sql`
    SELECT event_type FROM outbox_messages
    WHERE payload->'data'->>'transactionId' = ${transactionId}
    ORDER BY occurred_at, event_type`;
  return rows.map((row) => row.event_type);
}

async function walletBalance(app: TestApp, walletId: string): Promise<string> {
  return (await app.request("GET", `/wallets/${walletId}`)).body.balance.amount;
}

/** The value of the `name` series carrying `label` (other labels, such as the instance, are ignored). */
async function metricValue(app: TestApp, name: string, label: string): Promise<number> {
  const response = await fetch(`${app.baseUrl}/metrics`);
  const line = (await response.text())
    .split("\n")
    .find((candidate) => candidate.startsWith(`${name}{`) && candidate.includes(label));
  return line ? Number(line.slice(line.lastIndexOf(" ") + 1)) : 0;
}

describe("worker: the reference arrives within the window", () => {
  let app: TestApp;

  beforeAll(async () => {
    // The decided 20 attempts, with the delays shrunk to milliseconds (a window of about 3.5 s).
    app = await startTestApp({
      APP_ROLES: "api,pending-reference",
      PENDING_REFERENCE_POLL_INTERVAL_MS: "20",
      PENDING_REFERENCE_RETRY_BASE_MS: "20",
      PENDING_REFERENCE_RETRY_MAX_MS: "200",
      PENDING_REFERENCE_MAX_ATTEMPTS: "20",
    });
  });

  afterAll(async () => {
    await app.close();
  });

  test("a REFUND sent before its BET settles once the BET lands", async () => {
    const { providerId, wallet } = await scenario(app);
    const betId = newId();
    const refund = await submitOk(
      app,
      wagerBody({ providerId, wallet, kind: "REFUND", amount: "30.00", referenceExternalTransactionId: betId }),
      202,
    );
    expect(refund.status).toBe("PENDING_REFERENCE");
    const bet = await submitOk(
      app,
      wagerBody({ providerId, wallet, kind: "BET", amount: "30.00", externalTransactionId: betId }),
      201,
    );

    const settled = await eventually(async () => {
      const view = (await getTransaction(app, refund.transactionId)).body;
      expect(view.status).toBe("PROCESSED");
      return view;
    });
    expect(settled.referenceTransactionId).toBe(bet.transactionId);
    expect(settled.balance).toEqual({ amount: "100.00", currency: "BRL" });
    expect(await walletBalance(app, wallet.id)).toBe("100.00");
    expect(await eventTypesOf(refund.transactionId)).toEqual([
      "WagerTransactionPendingReference",
      "WagerTransactionProcessed",
      "WalletBalanceChanged",
    ]);
  });

  test("a ROLLBACK sent before its WIN settles with the inverse direction, and its replay returns the settled result", async () => {
    const { providerId, wallet } = await scenario(app);
    const winId = newId();
    const rollbackBody = wagerBody({
      providerId,
      wallet,
      kind: "ROLLBACK",
      amount: "25.00",
      referenceExternalTransactionId: winId,
    });
    const rollback = await submitOk(app, rollbackBody, 202);
    await submitOk(
      app,
      wagerBody({ providerId, wallet, kind: "WIN", amount: "25.00", externalTransactionId: winId }),
      201,
    );

    await eventually(async () => {
      expect((await getTransaction(app, rollback.transactionId)).body.status).toBe("PROCESSED");
    });
    expect(await walletBalance(app, wallet.id)).toBe("100.00");
    const replay = await submit(app, rollbackBody);
    expect(replay.status).toBe(201);
    expect(replay.body).toEqual({
      transactionId: rollback.transactionId,
      status: "PROCESSED",
      balance: { amount: "100.00", currency: "BRL" },
      idempotentReplay: true,
    });
  });
});

describe("worker: the retry window runs out", () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await startTestApp({
      APP_ROLES: "api,pending-reference",
      PENDING_REFERENCE_POLL_INTERVAL_MS: "10",
      PENDING_REFERENCE_RETRY_BASE_MS: "10",
      PENDING_REFERENCE_RETRY_MAX_MS: "20",
      PENDING_REFERENCE_MAX_ATTEMPTS: "3",
    });
  });

  afterAll(async () => {
    await app.close();
  });

  test("a reference that never appears ends REJECTED REFERENCE_NOT_FOUND with its event", async () => {
    const { providerId, wallet } = await scenario(app);
    const refundBody = wagerBody({
      providerId,
      wallet,
      kind: "REFUND",
      amount: "10.00",
      referenceExternalTransactionId: newId(),
    });
    const refund = await submitOk(app, refundBody, 202);

    await eventually(async () => {
      expect((await getTransaction(app, refund.transactionId)).body.status).toBe("REJECTED");
    });
    const [row] = await sql`
      SELECT failure_code, attempts, next_attempt_at FROM wager_transactions WHERE id = ${refund.transactionId}`;
    expect(row).toEqual({ failure_code: "REFERENCE_NOT_FOUND", attempts: 3, next_attempt_at: null });
    expect(await eventTypesOf(refund.transactionId)).toEqual([
      "WagerTransactionPendingReference",
      "WagerTransactionRejected",
    ]);
    const [pending, rejected] = (
      await sql`SELECT payload FROM outbox_messages WHERE aggregate_id = ${refund.transactionId} ORDER BY occurred_at`
    ).map((event: { payload: OutboxPayload }) => event.payload);
    expect(rejected.data.failureCode).toBe("REFERENCE_NOT_FOUND");
    // The rejection continues the correlation of the request that created the pending transaction.
    expect(rejected.correlationId).toBe(pending.correlationId);
    expect(rejected.causationId).toBe(refund.transactionId);

    const replay = await submit(app, refundBody);
    expect(replay.status).toBe(422);
    expect(replay.body).toMatchObject({ status: "REJECTED", code: "REFERENCE_NOT_FOUND", idempotentReplay: true });
    expect(await walletBalance(app, wallet.id)).toBe("100.00");
  });
});

/** Ticks driven directly (no worker role), so lock waits and failures are observed deterministically. */
describe("RetryPendingReferences tick", () => {
  /** PENDING_REFERENCE_MAX_ATTEMPTS as decided in spec OQ-09, which this application keeps. */
  const DECIDED_MAX_ATTEMPTS = 20;
  let app: TestApp;
  let retrier: RetryPendingReferences;
  /** Same application with a short `lock_timeout`, for the lock-timeout path. */
  let impatientApp: TestApp;

  beforeAll(async () => {
    // A lock wait far longer than the test needs, so a slow host cannot turn the busy-wallet wait into a timeout.
    app = await startTestApp({ DB_LOCK_TIMEOUT_MS: "5000" });
    retrier = app.app.get(RetryPendingReferences);
    impatientApp = await startTestApp({ DB_LOCK_TIMEOUT_MS: "200" });
  });

  afterAll(async () => {
    await app.close();
    await impatientApp.close();
  });

  /** A REFUND whose BET has landed, made due ahead of any other pending transaction in the database. */
  async function dueRefund({ providerId, wallet }: Scenario, amount = "30.00"): Promise<string> {
    const betId = newId();
    const refund = await submitOk(
      app,
      wagerBody({ providerId, wallet, kind: "REFUND", amount, referenceExternalTransactionId: betId }),
      202,
    );
    await submitOk(app, wagerBody({ providerId, wallet, kind: "BET", amount, externalTransactionId: betId }), 201);
    await sql`UPDATE wager_transactions SET next_attempt_at = '2000-01-01T00:00:00Z' WHERE id = ${refund.transactionId}`;
    return refund.transactionId;
  }

  async function statusOf(transactionId: string) {
    const [row] = await sql`
      SELECT status, failure_code, attempts, next_attempt_at FROM wager_transactions WHERE id = ${transactionId}`;
    return row;
  }

  /** Holds the wallet row lock from another session until the returned release is called. */
  async function lockWalletElsewhere(walletId: string): Promise<() => Promise<void>> {
    const session = await sql.reserve();
    await session`BEGIN`;
    await session`SELECT id FROM wallets WHERE id = ${walletId} FOR UPDATE`;
    return async () => {
      await session`COMMIT`;
      session.release();
    };
  }

  test("a reference that exists but stays pending for the whole window ends REJECTED REFERENCE_NOT_PROCESSED", async () => {
    const { providerId, wallet } = await scenario(app);
    const refundId = newId();
    const refund = await submitOk(
      app,
      wagerBody({
        providerId,
        wallet,
        kind: "REFUND",
        amount: "10.00",
        externalTransactionId: refundId,
        referenceExternalTransactionId: newId(),
      }),
      202,
    );
    await sql`UPDATE wager_transactions SET next_attempt_at = '2999-01-01T00:00:00Z' WHERE id = ${refund.transactionId}`;
    const rollback = await submitOk(
      app,
      wagerBody({ providerId, wallet, kind: "ROLLBACK", amount: "10.00", referenceExternalTransactionId: refundId }),
      202,
    );

    // The decided window is 20 attempts (spec OQ-09); each tick below uses one of them.
    for (let attempt = 1; attempt <= DECIDED_MAX_ATTEMPTS; attempt += 1) {
      expect((await statusOf(rollback.transactionId)).status).toBe("PENDING_REFERENCE");
      await sql`UPDATE wager_transactions SET next_attempt_at = '2000-01-01T00:00:00Z' WHERE id = ${rollback.transactionId}`;
      await retrier.execute();
    }

    expect(await statusOf(rollback.transactionId)).toEqual({
      status: "REJECTED",
      failure_code: "REFERENCE_NOT_PROCESSED",
      attempts: DECIDED_MAX_ATTEMPTS,
      next_attempt_at: null,
    });
    expect(await statusOf(refund.transactionId)).toMatchObject({ status: "PENDING_REFERENCE", attempts: 0 });
    expect(await walletBalance(app, wallet.id)).toBe("100.00");
  });

  test("a busy wallet is waited for, not skipped", async () => {
    const setup = await scenario(app);
    const refundId = await dueRefund(setup);
    const release = await lockWalletElsewhere(setup.wallet.id);

    let tickDone = false;
    const tick = retrier.execute().finally(() => {
      tickDone = true;
    });
    try {
      await eventually(async () => {
        const [{ waiting }] = await sql`
          SELECT COUNT(*)::int AS waiting FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'`;
        expect(waiting).toBeGreaterThan(0);
      });
      expect(tickDone).toBe(false);
    } finally {
      await release();
    }
    await tick;

    expect(await statusOf(refundId)).toMatchObject({ status: "PROCESSED", attempts: 0 });
    expect(await walletBalance(app, setup.wallet.id)).toBe("100.00");
  });

  test("a lock timeout leaves the transaction untouched for the next tick", async () => {
    const setup = await scenario(app);
    const refundId = await dueRefund(setup);
    const before = await statusOf(refundId);
    const retriesBefore = await metricValue(impatientApp, "wagering_retries_total", 'component="pending_reference"');
    const timeoutsBefore = await metricValue(impatientApp, "wagering_lock_conflicts_total", 'reason="timeout"');
    const release = await lockWalletElsewhere(setup.wallet.id);
    try {
      await impatientApp.app.get(RetryPendingReferences).execute();
    } finally {
      await release();
    }

    expect(await statusOf(refundId)).toEqual(before);
    expect(await metricValue(impatientApp, "wagering_retries_total", 'component="pending_reference"')).toBeGreaterThan(
      retriesBefore,
    );
    expect(await metricValue(impatientApp, "wagering_lock_conflicts_total", 'reason="timeout"')).toBeGreaterThan(
      timeoutsBefore,
    );

    await retrier.execute();
    expect((await statusOf(refundId)).status).toBe("PROCESSED");
  });

  test("a permanent database error marks the transaction FAILED PROCESSING_FAILED, with no event", async () => {
    // The refund credit would push the balance past numeric(20,2): PostgreSQL raises 22003 (spec 3.5).
    const setup = await scenario(app, "999999999999999990.00");
    const refundId = await dueRefund(setup, "5.00");
    await submitOk(app, wagerBody({ ...setup, kind: "WIN", amount: "14.99" }), 201);
    const balanceBefore = await walletBalance(app, setup.wallet.id);
    expect(balanceBefore).toBe("999999999999999999.99");

    await retrier.execute();

    expect(await statusOf(refundId)).toEqual({
      status: "FAILED",
      failure_code: "PROCESSING_FAILED",
      attempts: 0,
      next_attempt_at: null,
    });
    const view = (await getTransaction(app, refundId)).body;
    expect(view).toMatchObject({ status: "FAILED", failureCode: "PROCESSING_FAILED" });
    expect(await walletBalance(app, setup.wallet.id)).toBe(balanceBefore);
    expect(await eventTypesOf(refundId)).toEqual(["WagerTransactionPendingReference"]);
    const failedLog = app.logLines
      .map((line) => JSON.parse(line))
      .find((entry) => entry.event === "transaction.failed");
    expect(failedLog).toMatchObject({ level: "error", transactionId: refundId, errorCode: "INTEGRITY_VIOLATION" });
  });
});

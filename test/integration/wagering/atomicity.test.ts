import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Writable } from "node:stream";
import { EntityManager } from "@mikro-orm/postgresql";
import { Test, type TestingModule } from "@nestjs/testing";
import { AppModule } from "../../../src/app.module";
import type { OutboxRepository } from "../../../src/application/ports/outbox.repository";
import type { UnitOfWork } from "../../../src/application/ports/unit-of-work.port";
import { SubmitWagerTransaction } from "../../../src/application/wagering/submit-wager-transaction";
import type {
  SubmittableKind,
  SubmitWagerTransactionCommand,
} from "../../../src/application/wagering/submit-wager-transaction.command";
import { CreateWallet } from "../../../src/application/wallets/create-wallet";
import type { OutboxMessage } from "../../../src/domain/messaging/outbox-message";
import { Money } from "../../../src/domain/money/money";
import { FailureCode } from "../../../src/domain/wagering/failure-code";
import { WagerTransactionKind } from "../../../src/domain/wagering/wager-transaction-kind";
import { WagerTransactionStatus } from "../../../src/domain/wagering/wager-transaction-status";
import { createMetricsRegistry } from "../../../src/infrastructure/observability/metrics-registry";
import { createPino } from "../../../src/infrastructure/observability/pino-logger";
import { OUTBOX_REPOSITORY, UNIT_OF_WORK } from "../../../src/infrastructure/persistence/persistence.tokens";
import { MikroOrmOutboxRepository } from "../../../src/infrastructure/persistence/repositories/mikro-orm-outbox.repository";
import { sql } from "../../support/sql";
import { testConfig } from "../../support/test-config";
import { newId, newProviderId } from "../../support/wagering-requests";
import { checkWalletsAfterEach } from "../../support/wallet-consistency";

/**
 * T-I2 (database part): the wallet, transaction, ledger entry, wallet change and outbox rows commit together or not
 * at all, and each outcome writes exactly the outbox events of spec 3.6.
 */
class OutboxFailure extends Error {}

/** Really inserts the outbox rows inside the open transaction, then fails, so the rollback has something to undo. */
class FailingOutbox implements OutboxRepository {
  armed = false;

  constructor(
    private readonly outbox: MikroOrmOutboxRepository,
    private readonly em: EntityManager,
  ) {}

  add(messages: readonly OutboxMessage[]): void {
    this.outbox.add(messages);
    if (this.armed) {
      throw new OutboxFailure("outbox unavailable after insert");
    }
  }

  async flushThenFail(): Promise<never> {
    await this.em.flush();
    throw new OutboxFailure("outbox failed after flushing its rows");
  }
}

let moduleRef: TestingModule;
let outbox: FailingOutbox;
let unitOfWork: UnitOfWork;
const touchedWallets = checkWalletsAfterEach();
const config = testConfig();

beforeAll(async () => {
  const logger = createPino({
    level: "warn",
    instanceId: "atomicity",
    roles: ["api"],
    destination: new Writable({ write: (_c, _e, done) => done() }),
  });
  moduleRef = await Test.createTestingModule({
    imports: [AppModule.forRoot({ config, logger, registry: createMetricsRegistry("atomicity") })],
  })
    .overrideProvider(OUTBOX_REPOSITORY)
    .useFactory({
      factory: (em: EntityManager) => {
        outbox = new FailingOutbox(new MikroOrmOutboxRepository(em), em);
        return outbox;
      },
      inject: [EntityManager],
    })
    .compile();
  await moduleRef.init();
  unitOfWork = moduleRef.get<UnitOfWork>(UNIT_OF_WORK);
});

afterAll(async () => {
  await moduleRef.close();
});

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });
const origin = () => ({ correlationId: `corr-${newId()}`, causationId: newId() });

async function openWallet(amount: string) {
  const playerId = newId();
  const wallet = await unitOfWork.isolated(() =>
    moduleRef.get(CreateWallet).execute({ playerId, initialBalance: brl(amount) }, origin()),
  );
  touchedWallets.add(wallet.id);
  return wallet;
}

function betCommand(
  wallet: { id: string; playerId: string },
  kind: SubmittableKind = WagerTransactionKind.Bet,
  amount = "10.00",
): SubmitWagerTransactionCommand {
  const providerId = newProviderId();
  const externalTransactionId = newId();
  return {
    providerId,
    externalTransactionId,
    idempotencyKey: `${providerId}:${externalTransactionId}`,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: "round-1",
    gameId: "game-1",
    kind,
    money: brl(amount),
  };
}

async function outboxEventTypes(correlationId: string): Promise<string[]> {
  const rows = await sql`
    SELECT event_type FROM outbox_messages WHERE payload->>'correlationId' = ${correlationId} ORDER BY event_type`;
  return rows.map((row: { event_type: string }) => row.event_type);
}

async function rowCounts(walletId: string) {
  const [counts] = await sql`
    SELECT (SELECT COUNT(*)::int FROM wager_transactions WHERE wallet_id = ${walletId}) AS transactions,
           (SELECT COUNT(*)::int FROM wallet_ledger_entries WHERE wallet_id = ${walletId}) AS entries,
           (SELECT version FROM wallets WHERE id = ${walletId}) AS version,
           (SELECT balance::text FROM wallets WHERE id = ${walletId}) AS balance`;
  return counts;
}

describe("a failure after the outbox insert rolls everything back", () => {
  test("SubmitWagerTransaction leaves no transaction, ledger entry, wallet change or outbox row", async () => {
    const wallet = await openWallet("100.00");
    const before = await rowCounts(wallet.id);
    const context = { ...origin(), source: "http" as const };
    outbox.armed = true;
    try {
      const submission = moduleRef.get(SubmitWagerTransaction).execute(betCommand(wallet), context);
      await expect(submission).rejects.toBeInstanceOf(OutboxFailure);
    } finally {
      outbox.armed = false;
    }
    expect(await rowCounts(wallet.id)).toEqual(before);
    expect(await outboxEventTypes(context.correlationId)).toEqual([]);
  });

  test("rows already flushed to the database inside the transaction are rolled back too", async () => {
    const wallet = await openWallet("100.00");
    const before = await rowCounts(wallet.id);
    const command = betCommand(wallet);
    const context = { ...origin(), source: "http" as const };
    const flushedThenFailed = unitOfWork.isolated(() =>
      unitOfWork.run(async () => {
        await moduleRef.get(SubmitWagerTransaction).execute(command, context);
        return outbox.flushThenFail();
      }),
    );
    await expect(flushedThenFailed).rejects.toBeInstanceOf(OutboxFailure);
    expect(await rowCounts(wallet.id)).toEqual(before);
    expect(await outboxEventTypes(context.correlationId)).toEqual([]);
  });

  test("CreateWallet leaves no wallet, OPENING transaction, ledger entry or outbox row", async () => {
    const playerId = newId();
    const walletOrigin = origin();
    outbox.armed = true;
    try {
      const creation = unitOfWork.isolated(() =>
        moduleRef.get(CreateWallet).execute({ playerId, initialBalance: brl("100.00") }, walletOrigin),
      );
      await expect(creation).rejects.toBeInstanceOf(OutboxFailure);
    } finally {
      outbox.armed = false;
    }
    const [{ wallets }] = await sql`SELECT COUNT(*)::int AS wallets FROM wallets WHERE player_id = ${playerId}`;
    const [{ transactions }] =
      await sql`SELECT COUNT(*)::int AS transactions FROM wager_transactions WHERE player_id = ${playerId}`;
    expect({ wallets, transactions }).toEqual({ wallets: 0, transactions: 0 });
    expect(await outboxEventTypes(walletOrigin.correlationId)).toEqual([]);
  });
});

describe("the happy path commits every row together, with the outbox events of its outcome", () => {
  const submitAndRead = async (command: SubmitWagerTransactionCommand) => {
    const context = { ...origin(), source: "http" as const };
    const result = await moduleRef.get(SubmitWagerTransaction).execute(command, context);
    return { result, events: await outboxEventTypes(context.correlationId) };
  };

  test("OPENING above zero: wallet, transaction, entry, Processed and BalanceChanged", async () => {
    const walletOrigin = origin();
    const wallet = await unitOfWork.isolated(() =>
      moduleRef.get(CreateWallet).execute({ playerId: newId(), initialBalance: brl("100.00") }, walletOrigin),
    );
    touchedWallets.add(wallet.id);
    expect(await rowCounts(wallet.id)).toEqual({ transactions: 1, entries: 1, version: 1, balance: "100.00" });
    expect(await outboxEventTypes(walletOrigin.correlationId)).toEqual([
      "WagerTransactionProcessed",
      "WalletBalanceChanged",
    ]);
  });

  test("OPENING at zero: only the wallet, no transaction and no event", async () => {
    const walletOrigin = origin();
    const wallet = await unitOfWork.isolated(() =>
      moduleRef.get(CreateWallet).execute({ playerId: newId(), initialBalance: brl("0.00") }, walletOrigin),
    );
    touchedWallets.add(wallet.id);
    expect(await rowCounts(wallet.id)).toEqual({ transactions: 0, entries: 0, version: 1, balance: "0.00" });
    expect(await outboxEventTypes(walletOrigin.correlationId)).toEqual([]);
  });

  test("applied BET: transaction, debit entry, wallet change, Processed and BalanceChanged", async () => {
    const wallet = await openWallet("100.00");
    const { events } = await submitAndRead(betCommand(wallet));
    expect(await rowCounts(wallet.id)).toEqual({ transactions: 2, entries: 2, version: 2, balance: "90.00" });
    expect(events).toEqual(["WagerTransactionProcessed", "WalletBalanceChanged"]);
  });

  test("LOSS: transaction only, Processed only", async () => {
    const wallet = await openWallet("100.00");
    const { events } = await submitAndRead(betCommand(wallet, WagerTransactionKind.Loss, "0.00"));
    expect(await rowCounts(wallet.id)).toEqual({ transactions: 2, entries: 1, version: 1, balance: "100.00" });
    expect(events).toEqual(["WagerTransactionProcessed"]);
  });

  test("rejected: transaction only, Rejected", async () => {
    const wallet = await openWallet("5.00");
    const { result, events } = await submitAndRead(betCommand(wallet));
    expect(result.transaction.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(await rowCounts(wallet.id)).toEqual({ transactions: 2, entries: 1, version: 1, balance: "5.00" });
    expect(events).toEqual(["WagerTransactionRejected"]);
  });

  test("pending reference: transaction only, PendingReference", async () => {
    const wallet = await openWallet("100.00");
    const refund = { ...betCommand(wallet, WagerTransactionKind.Refund), referenceExternalTransactionId: newId() };
    const { result, events } = await submitAndRead(refund);
    expect(result.transaction.status).toBe(WagerTransactionStatus.PendingReference);
    expect(await rowCounts(wallet.id)).toEqual({ transactions: 2, entries: 1, version: 1, balance: "100.00" });
    expect(events).toEqual(["WagerTransactionPendingReference"]);
  });

  test("replay: no new row and no event", async () => {
    const wallet = await openWallet("100.00");
    const command = betCommand(wallet);
    await submitAndRead(command);
    const after = await rowCounts(wallet.id);
    const replay = await submitAndRead(command);
    expect(replay.result.idempotentReplay).toBe(true);
    expect(await rowCounts(wallet.id)).toEqual(after);
    expect(replay.events).toEqual([]);
  });
});

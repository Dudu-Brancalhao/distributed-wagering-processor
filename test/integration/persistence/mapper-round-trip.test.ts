import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { MikroORM, RequestContext } from "@mikro-orm/postgresql";
import { WagerTransactionProcessed } from "../../../src/domain/events/wager-transaction-processed";
import { OutboxMessage } from "../../../src/domain/messaging/outbox-message";
import { RetrySchedule } from "../../../src/domain/messaging/retry-schedule";
import { Money } from "../../../src/domain/money/money";
import { FailureCode } from "../../../src/domain/wagering/failure-code";
import { WagerTransaction } from "../../../src/domain/wagering/wager-transaction";
import { WagerTransactionKind } from "../../../src/domain/wagering/wager-transaction-kind";
import { WagerTransactionProcessor } from "../../../src/domain/wagering/wager-transaction-processor";
import { Wallet } from "../../../src/domain/wallet/wallet";
import { OutboxMessageMapper } from "../../../src/infrastructure/persistence/mappers/outbox-message.mapper";
import { mikroOrmOptions } from "../../../src/infrastructure/persistence/mikro-orm.config";
import { MikroOrmUnitOfWork } from "../../../src/infrastructure/persistence/mikro-orm-unit-of-work";
import { OutboxMessageRecord } from "../../../src/infrastructure/persistence/records/outbox-message.record";
import { MikroOrmLedgerRepository } from "../../../src/infrastructure/persistence/repositories/mikro-orm-ledger.repository";
import { MikroOrmOutboxRepository } from "../../../src/infrastructure/persistence/repositories/mikro-orm-outbox.repository";
import { MikroOrmWagerTransactionRepository } from "../../../src/infrastructure/persistence/repositories/mikro-orm-wager-transaction.repository";
import { MikroOrmWalletRepository } from "../../../src/infrastructure/persistence/repositories/mikro-orm-wallet.repository";
import { testConfig } from "../../support/test-config";
import { newId } from "../../support/wagering-requests";
import { checkWalletsAfterEach } from "../../support/wallet-consistency";

/** Domain objects written through the repositories come back identical through the mappers' `rehydrate` path. */
let orm: MikroORM;
const touchedWallets = checkWalletsAfterEach();

beforeAll(async () => {
  orm = await MikroORM.init(mikroOrmOptions(testConfig()));
});

afterAll(async () => {
  await orm.close();
});

function adapters() {
  return {
    unitOfWork: new MikroOrmUnitOfWork(orm.em),
    wallets: new MikroOrmWalletRepository(orm.em),
    transactions: new MikroOrmWagerTransactionRepository(orm.em),
    ledger: new MikroOrmLedgerRepository(orm.em),
    outbox: new MikroOrmOutboxRepository(orm.em),
  };
}

/** Writes in one context and reads in a fresh one, so nothing comes from the identity map. */
async function writeThenRead<T>(write: () => Promise<void>, read: () => Promise<T>): Promise<T> {
  await RequestContext.create(orm.em, write);
  return RequestContext.create(orm.em, read);
}

const at = new Date("2026-11-06T12:34:56.789Z");
const brl = (amount: string) => Money.from({ amount, currency: "BRL" });

function openWallet(amount: string) {
  const openingTransactionId = newId();
  const opened = Wallet.open({
    id: newId(),
    playerId: newId(),
    initialBalance: brl(amount),
    openingTransactionId,
    openingEntryId: newId(),
    now: at,
  });
  const opening = WagerTransaction.opening(
    {
      id: openingTransactionId,
      providerId: "_system",
      externalTransactionId: opened.wallet.id,
      idempotencyKey: `wallet-opening:${opened.wallet.id}`,
      payloadHash: "b".repeat(64),
      correlationId: "corr-round-trip",
      walletId: opened.wallet.id,
      playerId: opened.wallet.playerId,
      roundId: "wallet-opening",
      gameId: "wallet-opening",
      money: brl(amount),
      createdAt: at,
    },
    { balance: opened.wallet.balance, walletVersion: opened.wallet.version },
  );
  touchedWallets.add(opened.wallet.id);
  return { ...opened, opening };
}

function providerTransaction(wallet: Wallet, kind: WagerTransactionKind, amount: string, reference?: string) {
  return WagerTransaction.create({
    id: newId(),
    providerId: "provider-round-trip",
    externalTransactionId: newId(),
    idempotencyKey: newId(),
    payloadHash: "c".repeat(64),
    correlationId: "corr-round-trip",
    walletId: wallet.id,
    playerId: wallet.playerId,
    roundId: "round-1",
    gameId: "game-1",
    kind,
    money: brl(amount),
    referenceExternalTransactionId: reference,
    createdAt: at,
  });
}

/** The observable state of a transaction, read through its public getters. */
function stateOf(transaction: WagerTransaction | undefined) {
  if (!transaction) return undefined;
  const { id, providerId, externalTransactionId, idempotencyKey, payloadHash, correlationId, walletId, playerId } =
    transaction;
  return {
    id,
    providerId,
    externalTransactionId,
    idempotencyKey,
    payloadHash,
    correlationId,
    walletId,
    playerId,
    roundId: transaction.roundId,
    gameId: transaction.gameId,
    kind: transaction.kind,
    money: transaction.money,
    referenceExternalTransactionId: transaction.referenceExternalTransactionId,
    referenceTransactionId: transaction.referenceTransactionId,
    status: transaction.status,
    failureCode: transaction.failureCode,
    observedBalance: transaction.observedBalance,
    observedWalletVersion: transaction.observedWalletVersion,
    attempts: transaction.attempts,
    nextAttemptAt: transaction.nextAttemptAt,
    createdAt: transaction.createdAt,
    updatedAt: transaction.updatedAt,
    processedAt: transaction.processedAt,
  };
}

const processor = new WagerTransactionProcessor(
  { schedule: RetrySchedule.of({ baseMs: 1000, capMs: 300_000 }), maxAttempts: 20 },
  () => 0.5,
);

describe("mapper round trip", () => {
  test("wallet, OPENING transaction, ledger entry and outbox message", async () => {
    const { wallet, openingEntry, opening } = openWallet("100.00");
    const message = OutboxMessage.enqueue(
      WagerTransactionProcessed.from(opening, { eventId: newId(), correlationId: "corr-round-trip", occurredAt: at }),
    );
    const repositories = adapters();
    const loaded = await writeThenRead(
      () =>
        repositories.unitOfWork.run(async () => {
          repositories.wallets.add(wallet);
          repositories.transactions.add(opening);
          if (openingEntry) repositories.ledger.add(openingEntry);
          repositories.outbox.add([message]);
        }),
      async () => ({
        wallet: await repositories.wallets.findById(wallet.id),
        opening: await repositories.transactions.findById(opening.id),
        entries: await repositories.ledger.listByWallet({ walletId: wallet.id, limit: 10 }),
        message: OutboxMessageMapper.toDomain(await orm.em.findOneOrFail(OutboxMessageRecord, { id: message.id })),
      }),
    );
    expect(loaded.wallet).toEqual(wallet);
    expect(stateOf(loaded.opening)).toEqual(stateOf(opening));
    expect(loaded.entries).toEqual(openingEntry ? [openingEntry] : []);
    expect(loaded.entries).toHaveLength(1);
    expect(loaded.message).toEqual(message);
  });

  test("a balance update and the nullable columns of applied, rejected and pending transactions", async () => {
    const { wallet, openingEntry, opening } = openWallet("50.00");
    const repositories = adapters();
    await RequestContext.create(orm.em, () =>
      repositories.unitOfWork.run(async () => {
        repositories.wallets.add(wallet);
        repositories.transactions.add(opening);
        if (openingEntry) repositories.ledger.add(openingEntry);
      }),
    );
    const bet = providerTransaction(wallet, WagerTransactionKind.Bet, "20.00");
    const rejected = providerTransaction(wallet, WagerTransactionKind.Bet, "90.00");
    const pending = providerTransaction(wallet, WagerTransactionKind.Refund, "5.00", "missing-reference");
    const loaded = await writeThenRead(
      () =>
        repositories.unitOfWork.run(async () => {
          const locked = await repositories.wallets.lockById(wallet.id);
          if (!locked) throw new Error("wallet not found");
          const applied = processor.process({
            transaction: bet,
            wallet: locked,
            referenceAlreadyReversed: false,
            entryId: newId(),
            at,
          });
          processor.process({
            transaction: rejected,
            wallet: locked,
            referenceAlreadyReversed: false,
            entryId: newId(),
            at,
          });
          processor.process({
            transaction: pending,
            wallet: locked,
            referenceAlreadyReversed: false,
            entryId: newId(),
            at,
          });
          for (const transaction of [bet, rejected, pending]) repositories.transactions.add(transaction);
          if (applied.kind === "applied" && applied.entry) repositories.ledger.add(applied.entry);
          repositories.wallets.updateBalance(locked);
        }),
      async () => ({
        wallet: await repositories.wallets.findById(wallet.id),
        bet: await repositories.transactions.findById(bet.id),
        rejected: await repositories.transactions.findByIdempotencyKey(rejected.providerId, rejected.idempotencyKey),
        pending: await repositories.transactions.findByExternalId(pending.providerId, pending.externalTransactionId),
      }),
    );
    expect(loaded.wallet?.balance.toJSON()).toEqual({ amount: "30.00", currency: "BRL" });
    expect(loaded.wallet?.version).toBe(2);
    expect(stateOf(loaded.bet)).toEqual(stateOf(bet));
    expect(stateOf(loaded.rejected)).toEqual(stateOf(rejected));
    expect(loaded.rejected?.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(stateOf(loaded.pending)).toEqual(stateOf(pending));
    expect(loaded.pending?.nextAttemptAt).toBeInstanceOf(Date);
  });
});

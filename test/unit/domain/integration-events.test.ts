import { describe, expect, test } from "bun:test";
import { WagerTransactionPendingReference } from "../../../src/domain/events/wager-transaction-pending-reference";
import { WagerTransactionProcessed } from "../../../src/domain/events/wager-transaction-processed";
import { WagerTransactionRejected } from "../../../src/domain/events/wager-transaction-rejected";
import { WalletBalanceChanged } from "../../../src/domain/events/wallet-balance-changed";
import { InvalidTransactionStateError } from "../../../src/domain/shared/invalid-transaction-state.error";
import { FailureCode } from "../../../src/domain/wagering/failure-code";
import { LedgerDirection } from "../../../src/domain/wallet/ledger-direction";
import { Kind, nextId, processor, T0, transaction, walletWith } from "../support/fixtures";

const context = { eventId: "evt-1", correlationId: "corr-1", causationId: "msg-1", occurredAt: T0 };

function processedBet() {
  const wallet = walletWith("100.00");
  const bet = transaction(Kind.Bet, "25.00");
  const outcome = processor().process({
    transaction: bet,
    wallet,
    referenceAlreadyReversed: false,
    entryId: nextId(),
    at: T0,
  });
  if (outcome.kind !== "applied" || !outcome.entry) throw new Error("expected an applied bet");
  return { wallet, bet, entry: outcome.entry };
}

describe("integration events", () => {
  test("eventType and version are declared by each subclass", () => {
    const { wallet, bet, entry } = processedBet();
    expect(WagerTransactionProcessed.from(bet, context)).toMatchObject({
      eventType: "WagerTransactionProcessed",
      version: 1,
    });
    expect(WalletBalanceChanged.from(wallet, entry, context)).toMatchObject({
      eventType: "WalletBalanceChanged",
      version: 1,
    });
  });

  test("toJSON returns the envelope with an ISO timestamp and MoneyProps in data", () => {
    const { wallet, entry } = processedBet();
    const json = WalletBalanceChanged.from(wallet, entry, context).toJSON();
    expect(json).toEqual({
      eventId: "evt-1",
      eventType: "WalletBalanceChanged",
      aggregateId: wallet.id,
      correlationId: "corr-1",
      causationId: "msg-1",
      occurredAt: "2026-11-06T00:00:00.000Z",
      version: 1,
      data: {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        direction: LedgerDirection.Debit,
        money: { amount: "25.00", currency: "BRL" },
        balanceBefore: { amount: "100.00", currency: "BRL" },
        balanceAfter: { amount: "75.00", currency: "BRL" },
        walletVersion: 2,
      },
    });
    expect(JSON.parse(JSON.stringify(json))).toEqual(json);
  });

  test("WagerTransactionProcessed carries the observed balance and version", () => {
    const { bet } = processedBet();
    const { data, aggregateId } = WagerTransactionProcessed.from(bet, context).toJSON();
    expect(aggregateId).toBe(bet.id);
    expect(data).toMatchObject({ kind: "BET", money: { amount: "25.00", currency: "BRL" }, walletVersion: 2 });
    expect(data.balance).toEqual({ amount: "75.00", currency: "BRL" });
  });

  test("causationId is omitted when absent", () => {
    const { bet } = processedBet();
    const json = WagerTransactionProcessed.from(bet, { ...context, causationId: undefined }).toJSON();
    expect("causationId" in json).toBe(false);
  });

  test("WagerTransactionRejected carries the failure code", () => {
    const wallet = walletWith("1.00");
    const bet = transaction(Kind.Bet, "25.00");
    processor().process({ transaction: bet, wallet, referenceAlreadyReversed: false, entryId: nextId(), at: T0 });
    expect(WagerTransactionRejected.from(bet, context).toJSON().data.failureCode).toBe(FailureCode.InsufficientFunds);
  });

  test("WagerTransactionPendingReference carries the reference and next attempt", () => {
    const wallet = walletWith("10.00");
    const refund = transaction(Kind.Refund, "5.00", { referenceExternalTransactionId: "bet-x" });
    processor().process({ transaction: refund, wallet, referenceAlreadyReversed: false, entryId: nextId(), at: T0 });
    expect(WagerTransactionPendingReference.from(refund, context).toJSON().data).toMatchObject({
      referenceExternalTransactionId: "bet-x",
      attempts: 0,
      nextAttemptAt: "2026-11-06T00:00:01.000Z",
    });
  });

  test("events refuse transactions in the wrong status", () => {
    const pending = transaction(Kind.Bet, "1.00");
    expect(() => WagerTransactionProcessed.from(pending, context)).toThrow(InvalidTransactionStateError);
    expect(() => WagerTransactionRejected.from(pending, context)).toThrow(InvalidTransactionStateError);
    expect(() => WagerTransactionPendingReference.from(pending, context)).toThrow(InvalidTransactionStateError);
  });

  test("event data is frozen", () => {
    const { bet } = processedBet();
    expect(Object.isFrozen(WagerTransactionProcessed.from(bet, context).data)).toBe(true);
  });
});

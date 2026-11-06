import { describe, expect, test } from "bun:test";
import { InvalidTransactionStateError } from "../../../src/domain/shared/invalid-transaction-state.error";
import { FailureCode } from "../../../src/domain/wagering/failure-code";
import { WagerTransaction } from "../../../src/domain/wagering/wager-transaction";
import { WagerTransactionStatus } from "../../../src/domain/wagering/wager-transaction-status";
import { InvalidWagerTransactionError } from "../../../src/domain/wagering/wagering.errors";
import { LedgerDirection } from "../../../src/domain/wallet/ledger-direction";
import { brl, Kind, T0, transaction } from "../support/fixtures";

const observation = { balance: brl("10.00"), walletVersion: 3 };
const T1 = new Date("2026-11-06T00:00:05.000Z");

describe("WagerTransaction.create", () => {
  test("is born PENDING", () => {
    const bet = transaction(Kind.Bet, "25.00");
    expect(bet.status).toBe(WagerTransactionStatus.Pending);
    expect(bet.attempts).toBe(0);
    expect(bet.isTerminal()).toBe(false);
  });

  test("rejects OPENING: it is internal only", () => {
    expect(() => transaction(Kind.Opening, "1.00")).toThrow(InvalidWagerTransactionError);
  });

  test.each([Kind.Refund, Kind.Rollback])("%s requires a reference", (kind) => {
    expect(() => transaction(kind, "1.00")).toThrow(InvalidWagerTransactionError);
    expect(transaction(kind, "1.00", { referenceExternalTransactionId: "bet-1" }).requiresReference()).toBe(true);
  });

  test("BET must not carry a reference", () => {
    expect(() => transaction(Kind.Bet, "1.00", { referenceExternalTransactionId: "x" })).toThrow(
      InvalidWagerTransactionError,
    );
  });

  test.each([Kind.Win, Kind.Loss])("%s may carry an optional reference", (kind) => {
    expect(transaction(kind, "1.00").hasReference()).toBe(false);
    expect(transaction(kind, "1.00", { referenceExternalTransactionId: "bet-1" }).hasReference()).toBe(true);
  });

  test("LOSS may be zero; every other kind needs a positive amount", () => {
    expect(transaction(Kind.Loss, "0.00").money.isZero()).toBe(true);
    for (const kind of [Kind.Bet, Kind.Win]) {
      expect(() => transaction(kind, "0.00")).toThrow(InvalidWagerTransactionError);
    }
  });
});

describe("WagerTransaction transitions", () => {
  test("PENDING -> PROCESSED records the reference, time and observation", () => {
    const refund = transaction(Kind.Refund, "5.00", { referenceExternalTransactionId: "bet-1" });
    refund.markProcessed({ at: T1, observation, referenceTransactionId: "tx-bet" });
    expect(refund.status).toBe(WagerTransactionStatus.Processed);
    expect(refund.referenceTransactionId).toBe("tx-bet");
    expect(refund.processedAt).toEqual(T1);
    expect(refund.observedBalance?.toJSON().amount).toBe("10.00");
    expect(refund.observedWalletVersion).toBe(3);
  });

  test("processing a referencing transaction without its resolved reference is a programming error", () => {
    const refund = transaction(Kind.Refund, "5.00", { referenceExternalTransactionId: "bet-1" });
    expect(() => refund.markProcessed({ at: T1, observation })).toThrow(InvalidTransactionStateError);
  });

  test("PENDING -> REJECTED keeps the failure code", () => {
    const bet = transaction(Kind.Bet, "5.00");
    bet.reject(FailureCode.InsufficientFunds, { at: T1, observation });
    expect(bet.status).toBe(WagerTransactionStatus.Rejected);
    expect(bet.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(bet.processedAt).toBeUndefined();
  });

  test("PENDING -> PENDING_REFERENCE -> rescheduled -> PROCESSED", () => {
    const rollback = transaction(Kind.Rollback, "5.00", { referenceExternalTransactionId: "bet-1" });
    rollback.markPendingReference({ at: T0, nextAttemptAt: T1, observation });
    expect(rollback.status).toBe(WagerTransactionStatus.PendingReference);
    expect(rollback.nextAttemptAt).toEqual(T1);
    rollback.recordReferenceRetry({ at: T1, nextAttemptAt: new Date(T1.getTime() + 2000) });
    expect(rollback.attempts).toBe(1);
    rollback.markProcessed({ at: T1, observation, referenceTransactionId: "tx-bet" });
    expect(rollback.status).toBe(WagerTransactionStatus.Processed);
    expect(rollback.nextAttemptAt).toBeUndefined();
  });

  test("PENDING_REFERENCE -> FAILED", () => {
    const refund = transaction(Kind.Refund, "5.00", { referenceExternalTransactionId: "bet-1" });
    refund.markPendingReference({ at: T0, nextAttemptAt: T1, observation });
    refund.fail(FailureCode.ProcessingFailed, T1);
    expect(refund.status).toBe(WagerTransactionStatus.Failed);
    expect(refund.isTerminal()).toBe(true);
  });

  test("isDueForReferenceRetry: only a PENDING_REFERENCE transaction whose next attempt has come", () => {
    const refund = transaction(Kind.Refund, "5.00", { referenceExternalTransactionId: "bet-1" });
    expect(refund.isDueForReferenceRetry(T1)).toBe(false);
    refund.markPendingReference({ at: T0, nextAttemptAt: T1, observation });
    expect(refund.isDueForReferenceRetry(new Date(T1.getTime() - 1))).toBe(false);
    expect(refund.isDueForReferenceRetry(T1)).toBe(true);
    refund.fail(FailureCode.ProcessingFailed, T1);
    expect(refund.isDueForReferenceRetry(T1)).toBe(false);
  });

  test("only a PENDING transaction with a reference can enter PENDING_REFERENCE", () => {
    expect(() =>
      transaction(Kind.Bet, "1.00").markPendingReference({ at: T0, nextAttemptAt: T1, observation }),
    ).toThrow(InvalidTransactionStateError);
    expect(() => transaction(Kind.Bet, "1.00").recordReferenceRetry({ at: T0, nextAttemptAt: T1 })).toThrow(
      InvalidTransactionStateError,
    );
  });

  const terminalStates: Array<[string, (tx: WagerTransaction) => void]> = [
    ["PROCESSED", (tx) => tx.markProcessed({ at: T1, observation })],
    ["REJECTED", (tx) => tx.reject(FailureCode.InsufficientFunds, { at: T1, observation })],
    ["FAILED", (tx) => tx.fail(FailureCode.ProcessingFailed, T1)],
  ];
  const transitions: Array<[string, (tx: WagerTransaction) => void]> = [
    ["markProcessed", (tx) => tx.markProcessed({ at: T1, observation })],
    ["reject", (tx) => tx.reject(FailureCode.CurrencyMismatch, { at: T1, observation })],
    ["fail", (tx) => tx.fail(FailureCode.ProcessingFailed, T1)],
    ["markPendingReference", (tx) => tx.markPendingReference({ at: T1, nextAttemptAt: T1, observation })],
    ["recordReferenceRetry", (tx) => tx.recordReferenceRetry({ at: T1, nextAttemptAt: T1 })],
  ];
  for (const [state, reach] of terminalStates) {
    for (const [name, attempt] of transitions) {
      test(`${state} is terminal: ${name} throws InvalidTransactionStateError`, () => {
        const tx = transaction(Kind.Loss, "0.00");
        reach(tx);
        expect(() => attempt(tx)).toThrow(InvalidTransactionStateError);
        expect(tx.status).toBe(state as WagerTransactionStatus);
      });
    }
  }

  test("rehydrate restores any state without revalidating transitions", () => {
    const processed = transaction(Kind.Bet, "1.00");
    const restored = WagerTransaction.rehydrate({
      id: processed.id,
      providerId: processed.providerId,
      externalTransactionId: processed.externalTransactionId,
      idempotencyKey: processed.idempotencyKey,
      payloadHash: processed.payloadHash,
      correlationId: processed.correlationId,
      walletId: processed.walletId,
      playerId: processed.playerId,
      roundId: processed.roundId,
      gameId: processed.gameId,
      kind: processed.kind,
      money: processed.money,
      createdAt: T0,
      status: WagerTransactionStatus.Processed,
      attempts: 0,
      updatedAt: T1,
      processedAt: T1,
    });
    expect(restored.status).toBe(WagerTransactionStatus.Processed);
  });
});

describe("WagerTransaction queries", () => {
  test("affectsBalance is false only for LOSS", () => {
    expect(transaction(Kind.Loss, "0.00").affectsBalance()).toBe(false);
    expect(transaction(Kind.Bet, "1.00").affectsBalance()).toBe(true);
    expect(transaction(Kind.Win, "1.00").affectsBalance()).toBe(true);
  });

  test("matchesPayload compares the payload hash", () => {
    const bet = transaction(Kind.Bet, "1.00", { payloadHash: "b".repeat(64) });
    expect(bet.matchesPayload("b".repeat(64))).toBe(true);
    expect(bet.matchesPayload("c".repeat(64))).toBe(false);
  });

  test("ledgerDirectionFor: BET debits, WIN and REFUND credit, ROLLBACK inverts its reference", () => {
    const bet = transaction(Kind.Bet, "5.00");
    const win = transaction(Kind.Win, "5.00");
    const refund = transaction(Kind.Refund, "5.00", { referenceExternalTransactionId: "b" });
    const rollback = transaction(Kind.Rollback, "5.00", { referenceExternalTransactionId: "b" });
    expect(bet.ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(win.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(refund.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(rollback.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);
    expect(rollback.ledgerDirectionFor(win)).toBe(LedgerDirection.Debit);
    expect(rollback.ledgerDirectionFor(refund)).toBe(LedgerDirection.Debit);
    expect(() => rollback.ledgerDirectionFor()).toThrow(InvalidTransactionStateError);
    expect(() => transaction(Kind.Loss, "0.00").ledgerDirectionFor()).toThrow(InvalidTransactionStateError);
  });

  test("opening is created already PROCESSED with kind OPENING", () => {
    const opening = WagerTransaction.opening(
      {
        id: "tx-o",
        providerId: "_system",
        externalTransactionId: "wallet-1",
        idempotencyKey: "wallet-opening:wallet-1",
        payloadHash: "d".repeat(64),
        correlationId: "c",
        walletId: "wallet-1",
        playerId: "player-1",
        roundId: "wallet-opening",
        gameId: "wallet-opening",
        money: brl("100.00"),
        createdAt: T0,
      },
      { balance: brl("100.00"), walletVersion: 1 },
    );
    expect(opening.kind).toBe(Kind.Opening);
    expect(opening.status).toBe(WagerTransactionStatus.Processed);
    expect(opening.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
  });
});

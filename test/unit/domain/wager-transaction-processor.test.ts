import { describe, expect, test } from "bun:test";
import { Money } from "../../../src/domain/money/money";
import { FailureCode } from "../../../src/domain/wagering/failure-code";
import type { WagerTransaction } from "../../../src/domain/wagering/wager-transaction";
import type { ProcessingOutcome } from "../../../src/domain/wagering/wager-transaction-processor";
import { WagerTransactionStatus } from "../../../src/domain/wagering/wager-transaction-status";
import { LedgerDirection } from "../../../src/domain/wallet/ledger-direction";
import type { Wallet } from "../../../src/domain/wallet/wallet";
import { Kind, nextId, processor, T0, transaction, walletWith } from "../support/fixtures";

interface Run {
  readonly transaction: WagerTransaction;
  readonly wallet: Wallet;
  readonly reference?: WagerTransaction;
  readonly referenceAlreadyReversed?: boolean;
  readonly at?: Date;
}

function run(input: Run, maxAttempts?: number): ProcessingOutcome {
  return processor(maxAttempts).process({
    transaction: input.transaction,
    wallet: input.wallet,
    reference: input.reference,
    referenceAlreadyReversed: input.referenceAlreadyReversed ?? false,
    entryId: nextId("entry"),
    at: input.at ?? T0,
  });
}

/** A transaction already applied to `wallet`, usable as a reference. */
function applied(kind: Kind, amount: string, wallet: Wallet, extra: { referenceTo?: WagerTransaction } = {}) {
  const tx = transaction(kind, amount, {
    referenceExternalTransactionId: extra.referenceTo?.externalTransactionId,
  });
  const outcome = run({ transaction: tx, wallet, reference: extra.referenceTo });
  expect(outcome.kind).toBe("applied");
  return tx;
}

function expectRejected(outcome: ProcessingOutcome, tx: WagerTransaction, code: FailureCode) {
  expect(outcome).toEqual({ kind: "rejected", code });
  expect(tx.status).toBe(WagerTransactionStatus.Rejected);
  expect(tx.failureCode).toBe(code);
}

describe("BET", () => {
  test("debits the wallet with one DEBIT entry", () => {
    const wallet = walletWith("100.00");
    const bet = transaction(Kind.Bet, "25.00");
    const outcome = run({ transaction: bet, wallet });
    expect(outcome.kind === "applied" && outcome.entry?.direction).toBe(LedgerDirection.Debit);
    expect(wallet.balance.toJSON().amount).toBe("75.00");
    expect(bet.status).toBe(WagerTransactionStatus.Processed);
    expect(bet.observedBalance?.toJSON().amount).toBe("75.00");
    expect(bet.observedWalletVersion).toBe(2);
  });

  test("is rejected with INSUFFICIENT_FUNDS and leaves balance and version untouched", () => {
    const wallet = walletWith("100.00");
    applied(Kind.Bet, "80.00", wallet);
    const second = transaction(Kind.Bet, "80.00");
    expectRejected(run({ transaction: second, wallet }), second, FailureCode.InsufficientFunds);
    expect(wallet.balance.toJSON().amount).toBe("20.00");
    expect(wallet.version).toBe(2);
    expect(second.observedBalance?.toJSON().amount).toBe("20.00");
  });
});

describe("WIN and LOSS", () => {
  test("WIN credits with one CREDIT entry", () => {
    const wallet = walletWith("10.00");
    const outcome = run({ transaction: transaction(Kind.Win, "40.00"), wallet });
    expect(outcome.kind === "applied" && outcome.entry?.direction).toBe(LedgerDirection.Credit);
    expect(wallet.balance.toJSON().amount).toBe("50.00");
  });

  test("WIN may reference the BET of the same round", () => {
    const wallet = walletWith("10.00");
    const bet = applied(Kind.Bet, "5.00", wallet);
    const win = applied(Kind.Win, "15.00", wallet, { referenceTo: bet });
    expect(win.referenceTransactionId).toBe(bet.id);
    expect(wallet.balance.toJSON().amount).toBe("20.00");
  });

  test("LOSS is PROCESSED without moving the balance or creating an entry", () => {
    const wallet = walletWith("10.00");
    const loss = transaction(Kind.Loss, "0.00");
    expect(run({ transaction: loss, wallet })).toEqual({ kind: "applied", entry: undefined });
    expect(loss.status).toBe(WagerTransactionStatus.Processed);
    expect(wallet.version).toBe(1);
  });
});

describe("REFUND and ROLLBACK", () => {
  test("REFUND credits back a processed BET", () => {
    const wallet = walletWith("100.00");
    const bet = applied(Kind.Bet, "30.00", wallet);
    applied(Kind.Refund, "30.00", wallet, { referenceTo: bet });
    expect(wallet.balance.toJSON().amount).toBe("100.00");
  });

  test("ROLLBACK of a BET credits, of a WIN or REFUND debits", () => {
    const wallet = walletWith("100.00");
    const bet = applied(Kind.Bet, "30.00", wallet);
    applied(Kind.Rollback, "30.00", wallet, { referenceTo: bet });
    expect(wallet.balance.toJSON().amount).toBe("100.00");

    const win = applied(Kind.Win, "20.00", wallet);
    applied(Kind.Rollback, "20.00", wallet, { referenceTo: win });
    expect(wallet.balance.toJSON().amount).toBe("100.00");

    const bet2 = applied(Kind.Bet, "10.00", wallet);
    const refund = applied(Kind.Refund, "10.00", wallet, { referenceTo: bet2 });
    const rollback = transaction(Kind.Rollback, "10.00", {
      referenceExternalTransactionId: refund.externalTransactionId,
    });
    const outcome = run({ transaction: rollback, wallet, reference: refund });
    expect(outcome.kind === "applied" && outcome.entry?.direction).toBe(LedgerDirection.Debit);
    expect(wallet.balance.toJSON().amount).toBe("90.00");
  });

  test("a reversal that would go negative is REVERSAL_INSUFFICIENT_FUNDS, distinct from a bet without funds", () => {
    const wallet = walletWith("0.00");
    const win = applied(Kind.Win, "50.00", wallet);
    applied(Kind.Bet, "40.00", wallet);
    const rollback = transaction(Kind.Rollback, "50.00", { referenceExternalTransactionId: win.externalTransactionId });
    expectRejected(
      run({ transaction: rollback, wallet, reference: win }),
      rollback,
      FailureCode.ReversalInsufficientFunds,
    );
    expect(wallet.balance.toJSON().amount).toBe("10.00");
  });

  test("REFUND may only reference a BET; ROLLBACK may not reference LOSS or ROLLBACK", () => {
    const wallet = walletWith("100.00");
    const win = applied(Kind.Win, "5.00", wallet);
    const refund = transaction(Kind.Refund, "5.00", { referenceExternalTransactionId: win.externalTransactionId });
    expectRejected(run({ transaction: refund, wallet, reference: win }), refund, FailureCode.ReferenceKindNotAllowed);

    const loss = applied(Kind.Loss, "0.00", wallet);
    const rollback = transaction(Kind.Rollback, "1.00", { referenceExternalTransactionId: loss.externalTransactionId });
    expectRejected(
      run({ transaction: rollback, wallet, reference: loss }),
      rollback,
      FailureCode.ReferenceKindNotAllowed,
    );
  });

  test("the reference must share player, wallet, currency and round", () => {
    const wallet = walletWith("100.00");
    const otherRoundBet = transaction(Kind.Bet, "5.00", { roundId: "round-other" });
    run({ transaction: otherRoundBet, wallet });
    const refund = transaction(Kind.Refund, "5.00", {
      referenceExternalTransactionId: otherRoundBet.externalTransactionId,
    });
    expectRejected(
      run({ transaction: refund, wallet, reference: otherRoundBet }),
      refund,
      FailureCode.ReferenceScopeMismatch,
    );
  });

  test("a REJECTED reference cannot be reversed", () => {
    const wallet = walletWith("1.00");
    const bet = transaction(Kind.Bet, "5.00");
    run({ transaction: bet, wallet });
    const refund = transaction(Kind.Refund, "5.00", { referenceExternalTransactionId: bet.externalTransactionId });
    expectRejected(run({ transaction: refund, wallet, reference: bet }), refund, FailureCode.ReferenceNotProcessed);
  });

  test("the reversal amount must equal the reference amount (no partial reversal)", () => {
    const wallet = walletWith("100.00");
    const bet = applied(Kind.Bet, "30.00", wallet);
    const refund = transaction(Kind.Refund, "10.00", { referenceExternalTransactionId: bet.externalTransactionId });
    expectRejected(run({ transaction: refund, wallet, reference: bet }), refund, FailureCode.ReversalAmountMismatch);
  });

  test("a reference is reversed at most once, by any reversal kind (strict, OQ-07)", () => {
    const wallet = walletWith("100.00");
    const bet = applied(Kind.Bet, "30.00", wallet);
    applied(Kind.Refund, "30.00", wallet, { referenceTo: bet });
    for (const kind of [Kind.Refund, Kind.Rollback]) {
      const again = transaction(kind, "30.00", { referenceExternalTransactionId: bet.externalTransactionId });
      expectRejected(
        run({ transaction: again, wallet, reference: bet, referenceAlreadyReversed: true }),
        again,
        FailureCode.ReferenceAlreadyReversed,
      );
    }
    expect(wallet.balance.toJSON().amount).toBe("100.00");
  });

  test("checks run in order: kind before scope before amount", () => {
    const wallet = walletWith("100.00");
    const win = transaction(Kind.Win, "5.00", { roundId: "other" });
    run({ transaction: win, wallet });
    const refund = transaction(Kind.Refund, "9.00", { referenceExternalTransactionId: win.externalTransactionId });
    expectRejected(run({ transaction: refund, wallet, reference: win }), refund, FailureCode.ReferenceKindNotAllowed);
  });
});

describe("wallet scope", () => {
  test("currency conflict is REJECTED with CURRENCY_MISMATCH", () => {
    const wallet = walletWith("100.00");
    const bet = transaction(Kind.Bet, "1.00", { money: Money.from({ amount: "1.00", currency: "USD" }) });
    expectRejected(run({ transaction: bet, wallet }), bet, FailureCode.CurrencyMismatch);
    expect(bet.observedBalance?.toJSON()).toEqual({ amount: "100.00", currency: "BRL" });
  });

  test("a player that does not own the wallet is REJECTED with PLAYER_WALLET_MISMATCH", () => {
    const wallet = walletWith("100.00", { playerId: "someone-else" });
    const bet = transaction(Kind.Bet, "1.00");
    expectRejected(run({ transaction: bet, wallet }), bet, FailureCode.PlayerWalletMismatch);
    expect(wallet.balance.toJSON().amount).toBe("100.00");
  });
});

describe("missing references (PENDING_REFERENCE)", () => {
  test("a missing reference parks the transaction and schedules the first retry after the base delay", () => {
    const wallet = walletWith("100.00");
    const refund = transaction(Kind.Refund, "5.00", { referenceExternalTransactionId: "not-yet" });
    expect(run({ transaction: refund, wallet })).toEqual({ kind: "awaiting-reference" });
    expect(refund.status).toBe(WagerTransactionStatus.PendingReference);
    expect(refund.nextAttemptAt?.getTime()).toBe(T0.getTime() + 1000);
    expect(wallet.version).toBe(1);
  });

  test("a reference that is itself pending keeps the transaction waiting", () => {
    const wallet = walletWith("100.00");
    const pendingRefund = transaction(Kind.Refund, "5.00", { referenceExternalTransactionId: "missing-bet" });
    run({ transaction: pendingRefund, wallet });
    const rollback = transaction(Kind.Rollback, "5.00", {
      referenceExternalTransactionId: pendingRefund.externalTransactionId,
    });
    expect(run({ transaction: rollback, wallet, reference: pendingRefund })).toEqual({ kind: "awaiting-reference" });
  });

  test("the retry window lasts about one hour, then REFERENCE_NOT_FOUND", () => {
    const wallet = walletWith("100.00");
    const refund = transaction(Kind.Refund, "5.00", { referenceExternalTransactionId: "never" });
    run({ transaction: refund, wallet });
    let waitedMs = (refund.nextAttemptAt?.getTime() ?? 0) - T0.getTime();
    let outcome: ProcessingOutcome = { kind: "awaiting-reference" };
    while (outcome.kind === "awaiting-reference") {
      const at = refund.nextAttemptAt ?? T0;
      outcome = run({ transaction: refund, wallet, at });
      if (outcome.kind === "awaiting-reference") waitedMs = (refund.nextAttemptAt?.getTime() ?? 0) - T0.getTime();
    }
    expectRejected(outcome, refund, FailureCode.ReferenceNotFound);
    expect(refund.attempts).toBe(20);
    expect(waitedMs).toBe(3_811_000);
  });

  test("a reference that exists but never settles ends as REFERENCE_NOT_PROCESSED", () => {
    const wallet = walletWith("100.00");
    const pendingRefund = transaction(Kind.Refund, "5.00", { referenceExternalTransactionId: "missing-bet" });
    run({ transaction: pendingRefund, wallet });
    const rollback = transaction(Kind.Rollback, "5.00", {
      referenceExternalTransactionId: pendingRefund.externalTransactionId,
    });
    run({ transaction: rollback, wallet, reference: pendingRefund }, 2);
    run({ transaction: rollback, wallet, reference: pendingRefund }, 2);
    const outcome = run({ transaction: rollback, wallet, reference: pendingRefund }, 2);
    expectRejected(outcome, rollback, FailureCode.ReferenceNotProcessed);
  });

  test("a pending transaction is applied once its reference is processed", () => {
    const wallet = walletWith("100.00");
    const refund = transaction(Kind.Refund, "30.00", { referenceExternalTransactionId: "bet-late" });
    run({ transaction: refund, wallet });
    const bet = transaction(Kind.Bet, "30.00", { externalTransactionId: "bet-late" });
    run({ transaction: bet, wallet });
    const outcome = run({ transaction: refund, wallet, reference: bet, at: refund.nextAttemptAt });
    expect(outcome.kind).toBe("applied");
    expect(refund.referenceTransactionId).toBe(bet.id);
    expect(wallet.balance.toJSON().amount).toBe("100.00");
  });
});

import { describe, expect, test } from "bun:test";
import { Money } from "../../../src/domain/money/money";
import { CurrencyMismatchError } from "../../../src/domain/money/money.errors";
import { LedgerDirection } from "../../../src/domain/wallet/ledger-direction";
import { Wallet } from "../../../src/domain/wallet/wallet";
import { InsufficientFundsError, InvalidWalletError } from "../../../src/domain/wallet/wallet.errors";
import { brl, PLAYER_ID, T0, WALLET_ID, walletWith } from "../support/fixtures";

const T1 = new Date("2026-11-06T00:01:00.000Z");
const movement = (amount: string, currency = "BRL") => ({
  entryId: "entry-x",
  transactionId: "tx-x",
  money: Money.from({ amount, currency }),
  at: T1,
});

describe("Wallet.open", () => {
  test("with a positive balance: version 1 and an opening CREDIT entry from zero", () => {
    const { wallet, openingEntry } = Wallet.open({
      id: WALLET_ID,
      playerId: PLAYER_ID,
      initialBalance: brl("1000.00"),
      openingTransactionId: "tx-opening",
      openingEntryId: "entry-opening",
      now: T0,
    });
    expect(wallet.version).toBe(1);
    expect(wallet.currency).toBe("BRL");
    expect(wallet.balance.toJSON().amount).toBe("1000.00");
    expect(openingEntry?.direction).toBe(LedgerDirection.Credit);
    expect(openingEntry?.balanceBefore.toJSON().amount).toBe("0.00");
    expect(openingEntry?.balanceAfter.toJSON().amount).toBe("1000.00");
    expect(openingEntry?.walletVersion).toBe(1);
    expect(openingEntry?.transactionId).toBe("tx-opening");
  });

  test("with a zero balance: version 1 and no ledger entry", () => {
    const opened = Wallet.open({
      id: WALLET_ID,
      playerId: PLAYER_ID,
      initialBalance: brl("0.00"),
      openingTransactionId: "tx-opening",
      openingEntryId: "entry-opening",
      now: T0,
    });
    expect(opened.wallet.version).toBe(1);
    expect(opened.openingEntry).toBeUndefined();
  });

  test("rejects a negative initial balance", () => {
    expect(() =>
      Wallet.open({
        id: WALLET_ID,
        playerId: PLAYER_ID,
        initialBalance: Money.rehydrate({ amount: "-1.00", currency: "BRL" }),
        openingTransactionId: "t",
        openingEntryId: "e",
        now: T0,
      }),
    ).toThrow(InvalidWalletError);
  });
});

describe("Wallet balance movements", () => {
  test("debit returns the entry, lowers the balance and increments version by one", () => {
    const wallet = walletWith("100.00");
    const entry = wallet.debit(movement("80.00"));
    expect(wallet.balance.toJSON().amount).toBe("20.00");
    expect(wallet.version).toBe(2);
    expect(wallet.updatedAt).toEqual(T1);
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.walletVersion).toBe(2);
    expect(entry.balanceBefore.toJSON().amount).toBe("100.00");
    expect(entry.balanceAfter.toJSON().amount).toBe("20.00");
  });

  test("credit raises the balance", () => {
    const wallet = walletWith("10.00");
    wallet.credit(movement("5.50"));
    expect(wallet.balance.toJSON().amount).toBe("15.50");
    expect(wallet.version).toBe(2);
  });

  test("a debit larger than the balance throws and changes nothing", () => {
    const wallet = walletWith("100.00");
    wallet.debit(movement("80.00"));
    expect(() => wallet.debit(movement("80.00"))).toThrow(InsufficientFundsError);
    expect(wallet.balance.toJSON().amount).toBe("20.00");
    expect(wallet.version).toBe(2);
  });

  test("debiting the exact balance reaches zero, never below", () => {
    const wallet = walletWith("25.00");
    wallet.debit(movement("25.00"));
    expect(wallet.balance.isZero()).toBe(true);
  });

  test("operation currency must equal wallet currency", () => {
    const wallet = walletWith("100.00");
    expect(() => wallet.debit(movement("1.00", "USD"))).toThrow(CurrencyMismatchError);
    expect(() => wallet.credit(movement("1.00", "USD"))).toThrow(CurrencyMismatchError);
    expect(wallet.version).toBe(1);
  });

  test("a zero movement is refused, so version only moves with the balance", () => {
    const wallet = walletWith("100.00");
    expect(() => wallet.credit(movement("0.00"))).toThrow(InvalidWalletError);
    expect(wallet.version).toBe(1);
  });

  test("balance always equals the sum of its ledger entries", () => {
    const { wallet, openingEntry } = Wallet.open({
      id: WALLET_ID,
      playerId: PLAYER_ID,
      initialBalance: brl("50.00"),
      openingTransactionId: "o",
      openingEntryId: "e0",
      now: T0,
    });
    const entries = [openingEntry, wallet.debit(movement("20.00")), wallet.credit(movement("7.25"))].filter(
      (entry) => entry !== undefined,
    );
    const rebuilt = entries.reduce(
      (sum, entry) => (entry.direction === LedgerDirection.Credit ? sum.add(entry.money) : sum.subtract(entry.money)),
      Money.zero("BRL"),
    );
    expect(rebuilt.equals(wallet.balance)).toBe(true);
  });

  test("rehydrate restores state without revalidation", () => {
    const wallet = Wallet.rehydrate({
      id: WALLET_ID,
      playerId: PLAYER_ID,
      currency: "BRL",
      balance: brl("42.00"),
      version: 7,
      createdAt: T0,
      updatedAt: T1,
    });
    expect(wallet.version).toBe(7);
    expect(wallet.balance.toJSON().amount).toBe("42.00");
  });
});

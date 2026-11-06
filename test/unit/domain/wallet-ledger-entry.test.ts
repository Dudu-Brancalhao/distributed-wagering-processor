import { describe, expect, test } from "bun:test";
import { LedgerDirection } from "../../../src/domain/wallet/ledger-direction";
import { InvalidLedgerEntryError } from "../../../src/domain/wallet/wallet.errors";
import { type LedgerEntryState, WalletLedgerEntry } from "../../../src/domain/wallet/wallet-ledger-entry";
import { brl, T0 } from "../support/fixtures";

const state = (overrides: Partial<LedgerEntryState> = {}): LedgerEntryState => ({
  id: "entry-1",
  walletId: "wallet-1",
  transactionId: "tx-1",
  walletVersion: 2,
  direction: LedgerDirection.Debit,
  money: brl("10.00"),
  balanceBefore: brl("30.00"),
  balanceAfter: brl("20.00"),
  createdAt: T0,
  ...overrides,
});

describe("WalletLedgerEntry", () => {
  test("create accepts balanced debit and credit entries", () => {
    expect(WalletLedgerEntry.create(state()).isBalanced()).toBe(true);
    const credit = state({ direction: LedgerDirection.Credit, balanceAfter: brl("40.00") });
    expect(WalletLedgerEntry.create(credit).isBalanced()).toBe(true);
  });

  test("create rejects unbalanced arithmetic", () => {
    expect(() => WalletLedgerEntry.create(state({ balanceAfter: brl("21.00") }))).toThrow(InvalidLedgerEntryError);
  });

  test("create rejects a zero amount, negative balances and invalid versions", () => {
    expect(() => WalletLedgerEntry.create(state({ money: brl("0.00"), balanceAfter: brl("30.00") }))).toThrow(
      InvalidLedgerEntryError,
    );
    expect(() => WalletLedgerEntry.create(state({ walletVersion: 0 }))).toThrow(InvalidLedgerEntryError);
  });

  test("has no mutable state: fields are read-only and there are no transition methods", () => {
    const entry = WalletLedgerEntry.create(state());
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(entry)).filter((name) => name !== "constructor");
    expect(methods).toEqual(["isBalanced"]);
  });

  test("rehydrate does not revalidate", () => {
    expect(WalletLedgerEntry.rehydrate(state({ balanceAfter: brl("99.00") })).isBalanced()).toBe(false);
  });
});

import type { Money } from "../money/money";
import { LedgerDirection } from "./ledger-direction";
import { InvalidLedgerEntryError } from "./wallet.errors";

export interface LedgerEntryState {
  readonly id: string;
  readonly walletId: string;
  readonly transactionId: string;
  readonly walletVersion: number;
  readonly direction: LedgerDirection;
  readonly money: Money;
  readonly balanceBefore: Money;
  readonly balanceAfter: Money;
  readonly createdAt: Date;
}

/** Immutable record of one balance movement. There is no way to change an entry once created. */
export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly walletVersion: number,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    public readonly createdAt: Date,
  ) {}

  /** Validates the entry arithmetic: balanceBefore +/- money === balanceAfter, all non-negative, one currency. */
  static create(state: LedgerEntryState): WalletLedgerEntry {
    const entry = WalletLedgerEntry.rehydrate(state);
    if (!Number.isInteger(state.walletVersion) || state.walletVersion < 1) {
      throw new InvalidLedgerEntryError(`Invalid wallet version ${state.walletVersion}`);
    }
    if (!state.money.isPositive()) {
      throw new InvalidLedgerEntryError("A ledger entry must move a positive amount");
    }
    if (state.balanceBefore.isNegative() || state.balanceAfter.isNegative()) {
      throw new InvalidLedgerEntryError("Ledger balances must not be negative");
    }
    if (!entry.isBalanced()) {
      throw new InvalidLedgerEntryError(
        `Unbalanced entry: ${state.balanceBefore} ${state.direction} ${state.money} != ${state.balanceAfter}`,
      );
    }
    return entry;
  }

  /** Rebuilds a persisted entry without revalidating it. */
  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.walletVersion,
      state.direction,
      state.money,
      state.balanceBefore,
      state.balanceAfter,
      state.createdAt,
    );
  }

  isBalanced(): boolean {
    const expected =
      this.direction === LedgerDirection.Credit
        ? this.balanceBefore.add(this.money)
        : this.balanceBefore.subtract(this.money);
    return expected.equals(this.balanceAfter);
  }
}

import { Money } from "../money/money";
import { CurrencyMismatchError } from "../money/money.errors";
import { LedgerDirection } from "./ledger-direction";
import { InsufficientFundsError, InvalidWalletError } from "./wallet.errors";
import { WalletLedgerEntry } from "./wallet-ledger-entry";

export interface WalletState {
  readonly id: string;
  readonly playerId: string;
  readonly currency: string;
  readonly balance: Money;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface OpenWalletProps {
  readonly id: string;
  readonly playerId: string;
  readonly initialBalance: Money;
  readonly openingTransactionId: string;
  readonly openingEntryId: string;
  readonly now: Date;
}

export interface BalanceMovement {
  readonly entryId: string;
  readonly transactionId: string;
  readonly money: Money;
  readonly at: Date;
}

export interface OpenedWallet {
  readonly wallet: Wallet;
  /** Present only when the initial balance is above zero. */
  readonly openingEntry?: WalletLedgerEntry;
}

/**
 * Aggregate root for a player's balance in one currency. The balance only changes through `debit` and `credit`,
 * and each of them returns the ledger entry of that change, so balance and ledger cannot diverge.
 */
export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: OpenWalletProps): OpenedWallet {
    if (props.initialBalance.isNegative()) {
      throw new InvalidWalletError("The initial balance must not be negative");
    }
    const currency = props.initialBalance.currency;
    const wallet = new Wallet(props.id, props.playerId, currency, Money.zero(currency), 0, props.now, props.now);
    if (props.initialBalance.isZero()) {
      wallet._version = 1;
      return { wallet };
    }
    const openingEntry = wallet.apply(LedgerDirection.Credit, {
      entryId: props.openingEntryId,
      transactionId: props.openingTransactionId,
      money: props.initialBalance,
      at: props.now,
    });
    return { wallet, openingEntry };
  }

  /** Rebuilds persisted state without revalidating it. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  /** Throws `InsufficientFundsError` when the debit would make the balance negative. */
  debit(movement: BalanceMovement): WalletLedgerEntry {
    return this.apply(LedgerDirection.Debit, movement);
  }

  credit(movement: BalanceMovement): WalletLedgerEntry {
    return this.apply(LedgerDirection.Credit, movement);
  }

  canAfford(money: Money): boolean {
    this.assertSameCurrency(money);
    return !this._balance.isLessThan(money);
  }

  private apply(direction: LedgerDirection, movement: BalanceMovement): WalletLedgerEntry {
    this.assertSameCurrency(movement.money);
    if (!movement.money.isPositive()) {
      throw new InvalidWalletError("A balance movement must be positive");
    }
    if (direction === LedgerDirection.Debit && !this.canAfford(movement.money)) {
      throw new InsufficientFundsError(`Wallet ${this.id} cannot cover ${movement.money}`);
    }
    const balanceBefore = this._balance;
    const balanceAfter =
      direction === LedgerDirection.Credit ? balanceBefore.add(movement.money) : balanceBefore.subtract(movement.money);
    const entry = WalletLedgerEntry.create({
      id: movement.entryId,
      walletId: this.id,
      transactionId: movement.transactionId,
      walletVersion: this._version + 1,
      direction,
      money: movement.money,
      balanceBefore,
      balanceAfter,
      createdAt: movement.at,
    });
    this._balance = balanceAfter;
    this._version = entry.walletVersion;
    this._updatedAt = movement.at;
    return entry;
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }
}

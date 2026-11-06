import { CurrencyMismatchError, InvalidMoneyError } from "./money.errors";
import type { MoneyProps } from "./money-props";

const MINOR_UNITS_PER_UNIT = 100n;
const CONTRACT_AMOUNT = /^(0|[1-9][0-9]{0,17})\.([0-9]{2})$/;
const PERSISTED_AMOUNT = /^(-?)(0|[1-9][0-9]{0,17})\.([0-9]{2})$/;
const CURRENCY = /^[A-Z]{3}$/;

/** Immutable monetary amount with a fixed scale of two decimals, stored as a count of minor units. */
export class Money {
  private constructor(
    private readonly minorUnits: bigint,
    public readonly currency: string,
  ) {}

  /** Parses an input contract value: non-negative, exactly two decimals, uppercase ISO-4217 code. */
  static from(props: MoneyProps): Money {
    const { amount, currency } = Money.assertStrings(props);
    const match = CONTRACT_AMOUNT.exec(amount);
    if (!match) {
      throw new InvalidMoneyError(`Invalid amount "${amount}": expected a non-negative decimal with two decimals`);
    }
    return new Money(Money.toMinorUnits(match[1] ?? "", match[2] ?? ""), Money.assertCurrency(currency));
  }

  /** Rebuilds a value read from storage or computed by SQL. Accepts a leading minus sign. */
  static rehydrate(props: MoneyProps): Money {
    const { amount, currency } = Money.assertStrings(props);
    const match = PERSISTED_AMOUNT.exec(amount);
    if (!match) {
      throw new InvalidMoneyError(`Invalid stored amount "${amount}"`);
    }
    const magnitude = Money.toMinorUnits(match[2] ?? "", match[3] ?? "");
    return new Money(match[1] === "-" ? -magnitude : magnitude, Money.assertCurrency(currency));
  }

  static zero(currency: string): Money {
    return new Money(0n, Money.assertCurrency(currency));
  }

  get amount(): string {
    const sign = this.minorUnits < 0n ? "-" : "";
    const magnitude = this.minorUnits < 0n ? -this.minorUnits : this.minorUnits;
    const units = magnitude / MINOR_UNITS_PER_UNIT;
    const cents = (magnitude % MINOR_UNITS_PER_UNIT).toString().padStart(2, "0");
    return `${sign}${units}.${cents}`;
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minorUnits + other.minorUnits, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minorUnits - other.minorUnits, this.currency);
  }

  negate(): Money {
    return new Money(-this.minorUnits, this.currency);
  }

  isZero(): boolean {
    return this.minorUnits === 0n;
  }

  isPositive(): boolean {
    return this.minorUnits > 0n;
  }

  isNegative(): boolean {
    return this.minorUnits < 0n;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minorUnits < other.minorUnits;
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.minorUnits === other.minorUnits;
  }

  toJSON(): MoneyProps {
    return { amount: this.amount, currency: this.currency };
  }

  toString(): string {
    return `${this.amount} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (other.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }

  private static toMinorUnits(units: string, cents: string): bigint {
    return BigInt(units) * MINOR_UNITS_PER_UNIT + BigInt(cents);
  }

  private static assertStrings(props: MoneyProps): MoneyProps {
    if (typeof props?.amount !== "string" || typeof props?.currency !== "string") {
      throw new InvalidMoneyError("Money amount and currency must be strings");
    }
    return props;
  }

  private static assertCurrency(currency: string): string {
    if (!CURRENCY.test(currency)) {
      throw new InvalidMoneyError(`Invalid currency "${currency}": expected an uppercase ISO-4217 code`);
    }
    return currency;
  }
}

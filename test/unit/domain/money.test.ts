import { describe, expect, test } from "bun:test";
import { Money } from "../../../src/domain/money/money";
import { CurrencyMismatchError, InvalidMoneyError } from "../../../src/domain/money/money.errors";
import type { MoneyProps } from "../../../src/domain/money/money-props";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });

describe("Money.from (input contracts)", () => {
  test.each(["0.00", "25.00", "1000.10", "999999999999999999.99"])("accepts %p", (amount) => {
    expect(brl(amount).toJSON()).toEqual({ amount, currency: "BRL" });
  });

  test.each([
    ["NaN"],
    ["Infinity"],
    ["-Infinity"],
    ["1e3"],
    ["1E+2"],
    [""],
    ["1.005"],
    ["1"],
    ["1.0"],
    [".50"],
    ["-1.00"],
    ["+1.00"],
    ["01.00"],
    [" 1.00"],
    ["1.00 "],
    ["1,00"],
    ["1000000000000000000.00"],
  ])("rejects amount %p", (amount) => {
    expect(() => brl(amount)).toThrow(InvalidMoneyError);
  });

  test.each(["brl", "BR", "BRLL", "", "B1L"])("rejects currency %p", (currency) => {
    expect(() => Money.from({ amount: "1.00", currency })).toThrow(InvalidMoneyError);
  });

  test("rejects a JSON number instead of a decimal string", () => {
    expect(() => Money.from({ amount: 25 as unknown as string, currency: "BRL" })).toThrow(InvalidMoneyError);
    expect(() => Money.from(JSON.parse('{"amount":25.0,"currency":"BRL"}') as MoneyProps)).toThrow(InvalidMoneyError);
  });

  test("rejects a third decimal instead of rounding it", () => {
    expect(() => brl("0.015")).toThrow(InvalidMoneyError);
    expect(() => brl("10.999")).toThrow(InvalidMoneyError);
  });
});

describe("Money.rehydrate (stored and computed values)", () => {
  test("accepts a negative computed value", () => {
    expect(Money.rehydrate({ amount: "-5.00", currency: "BRL" }).toJSON()).toEqual({
      amount: "-5.00",
      currency: "BRL",
    });
  });

  test("normalizes negative zero", () => {
    expect(Money.rehydrate({ amount: "-0.00", currency: "BRL" }).toString()).toBe("0.00 BRL");
  });

  test.each(["1", "1.005", "abc", "--1.00"])("rejects %p", (amount) => {
    expect(() => Money.rehydrate({ amount, currency: "BRL" })).toThrow(InvalidMoneyError);
  });
});

describe("Money arithmetic", () => {
  test("is exact at the scale of two decimals (no floating point drift)", () => {
    expect(brl("0.10").add(brl("0.20")).toJSON().amount).toBe("0.30");
    expect(brl("999999999999999999.99").subtract(brl("0.01")).toJSON().amount).toBe("999999999999999999.98");
  });

  test("round-trips the numeric(20,2) maximum exactly through add, subtract and negate", () => {
    const max = "999999999999999999.99";
    const big = brl(max);
    expect(big.add(Money.zero("BRL")).toJSON().amount).toBe(max);
    expect(big.subtract(brl("0.00")).toJSON().amount).toBe(max);
    expect(big.negate().toJSON().amount).toBe(`-${max}`);
    expect(big.negate().negate().toJSON().amount).toBe(max);
    expect(Money.zero("BRL").subtract(big).toJSON().amount).toBe(`-${max}`);
    expect(brl("999999999999999999.98").add(brl("0.01")).toJSON().amount).toBe(max);
    expect(big.subtract(brl("999999999999999999.98")).toJSON().amount).toBe("0.01");
  });

  test("returns new instances and never mutates operands", () => {
    const a = brl("10.00");
    const b = brl("2.50");
    const sum = a.add(b);
    expect(sum).not.toBe(a);
    expect(a.toJSON().amount).toBe("10.00");
    expect(b.toJSON().amount).toBe("2.50");
  });

  test("subtract can go negative and negate flips the sign", () => {
    const difference = brl("1.00").subtract(brl("3.50"));
    expect(difference.toJSON().amount).toBe("-2.50");
    expect(difference.isNegative()).toBe(true);
    expect(difference.negate().toJSON().amount).toBe("2.50");
  });

  test("predicates and comparison", () => {
    expect(Money.zero("BRL").isZero()).toBe(true);
    expect(brl("0.01").isPositive()).toBe(true);
    expect(brl("1.00").isLessThan(brl("1.01"))).toBe(true);
    expect(brl("1.01").isLessThan(brl("1.01"))).toBe(false);
    expect(brl("1.00").equals(brl("1.00"))).toBe(true);
    expect(brl("1.00").equals(Money.from({ amount: "1.00", currency: "USD" }))).toBe(false);
  });

  test("operations across currencies throw a domain error", () => {
    const usd = Money.from({ amount: "1.00", currency: "USD" });
    expect(() => brl("1.00").add(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl("1.00").subtract(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl("1.00").isLessThan(usd)).toThrow(CurrencyMismatchError);
  });

  test("serializes with exactly two decimals", () => {
    expect(JSON.stringify(Money.zero("BRL"))).toBe('{"amount":"0.00","currency":"BRL"}');
    expect(brl("7.05").toString()).toBe("7.05 BRL");
  });
});

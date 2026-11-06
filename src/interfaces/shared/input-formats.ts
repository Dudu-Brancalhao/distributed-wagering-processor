import { z } from "zod";
import { Money } from "../../domain/money/money";
import { WagerTransactionKind } from "../../domain/wagering/wager-transaction-kind";

/**
 * Field formats shared by every entry point (spec 3.13). Lengths match the column widths, so a value that passes
 * validation always fits its column.
 */
const visibleAscii = (maxLength: number) =>
  z.string().regex(new RegExp(`^[\\x21-\\x7E]{1,${maxLength}}$`), `must be 1 to ${maxLength} visible ASCII characters`);

export const uuidField = z.guid("must be a UUID").transform((value) => value.toLowerCase());

/** Cannot start with `_`, which keeps the internal `_system` provider unreachable from outside. */
export const providerIdField = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/,
    "must be 1 to 64 letters, digits, '.', '_' or '-', not starting with '_'",
  );

export const externalIdField = visibleAscii(128);

export const idempotencyKeyField = visibleAscii(255);

/** Parses through `Money.from`, so a JSON number, a third decimal or a lowercase currency is a validation error. */
export const moneyField = z.object({ amount: z.unknown(), currency: z.unknown() }).transform((value, context) => {
  try {
    return Money.from(value as { amount: string; currency: string });
  } catch (error) {
    context.addIssue({ code: "custom", message: error instanceof Error ? error.message : "invalid money" });
    return z.NEVER;
  }
});

export const submittableKindField = z.enum([
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
]);

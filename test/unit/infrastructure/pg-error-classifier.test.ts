import { describe, expect, test } from "bun:test";
import {
  DuplicateRecordError,
  IntegrityViolationError,
  TransientInfrastructureError,
} from "../../../src/application/errors";
import { classifyDatabaseError } from "../../../src/infrastructure/persistence/pg-error-classifier";

function databaseError(code: string, constraint?: string): Error {
  return Object.assign(new Error(`database error ${code}`), { code, constraint });
}

describe("classifyDatabaseError", () => {
  test("a unique violation on a raced constraint is a duplicate record", () => {
    expect(classifyDatabaseError(databaseError("23505", "wager_tx_single_reversal"))).toBeInstanceOf(
      DuplicateRecordError,
    );
  });

  test.each([
    ["23505", "ledger_wallet_version_uq"],
    ["23514", "wallets_balance_check"],
    ["23503", "ledger_transaction_fk"],
    ["23001", undefined],
    ["23000", undefined],
    ["22001", undefined],
    ["22003", undefined],
  ])("SQLSTATE %s (%s) is an integrity violation (spec 3.10)", (code, constraint) => {
    const classified = classifyDatabaseError(databaseError(code, constraint));
    expect(classified).toBeInstanceOf(IntegrityViolationError);
    expect((classified as IntegrityViolationError).code).toBe("INTEGRITY_VIOLATION");
  });

  test("lock timeouts and unavailable servers stay transient", () => {
    expect(classifyDatabaseError(databaseError("55P03"))).toBeInstanceOf(TransientInfrastructureError);
    expect(classifyDatabaseError(databaseError("08006"))).toBeInstanceOf(TransientInfrastructureError);
  });

  test("an unrecognized error is returned unchanged", () => {
    const error = databaseError("42P01");
    expect(classifyDatabaseError(error)).toBe(error);
  });
});

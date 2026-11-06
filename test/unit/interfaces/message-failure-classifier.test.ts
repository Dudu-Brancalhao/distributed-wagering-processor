import { describe, expect, test } from "bun:test";
import {
  DuplicateRecordError,
  ExternalTransactionConflictError,
  IdempotencyConflictError,
  InboxPayloadMismatchError,
  IntegrityViolationError,
  TransientInfrastructureError,
  ValidationError,
  WalletNotFoundError,
} from "../../../src/application/errors";
import { InvalidMoneyError } from "../../../src/domain/money/money.errors";
import { classifyMessageFailure } from "../../../src/interfaces/sqs/message-failure-classifier";

describe("classifyMessageFailure (spec 3.14)", () => {
  test("idempotency and external id conflicts are business-terminal (OQ-23)", () => {
    expect(classifyMessageFailure(new IdempotencyConflictError("conflict"))).toEqual({
      kind: "business",
      code: "IDEMPOTENCY_KEY_CONFLICT",
    });
    expect(classifyMessageFailure(new ExternalTransactionConflictError("conflict"))).toEqual({
      kind: "business",
      code: "EXTERNAL_TRANSACTION_CONFLICT",
    });
  });

  test.each([
    [new ValidationError("bad"), "invalid_message", "VALIDATION_FAILED"],
    [new WalletNotFoundError("w", "reference"), "wallet_not_found", "WALLET_NOT_FOUND"],
    [new InboxPayloadMismatchError("m"), "inbox_payload_mismatch", "INBOX_PAYLOAD_MISMATCH"],
    [new IntegrityViolationError("bug"), "integrity_violation", "INTEGRITY_VIOLATION"],
    [new InvalidMoneyError("bad money"), "domain_rule_violation", "INVALID_MONEY"],
  ])("%p is permanent", (error, reason, code) => {
    expect(classifyMessageFailure(error)).toEqual({ kind: "permanent", reason, code });
  });

  test.each([
    [new TransientInfrastructureError("down", "database_unavailable")],
    [new DuplicateRecordError("idempotency_key")],
    [new Error("unclassified")],
    ["not even an error"],
  ])("%p is transient: unknown failures are retried, never dead-lettered early", (error) => {
    expect(classifyMessageFailure(error)).toEqual({ kind: "transient" });
  });
});

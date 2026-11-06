import { ApplicationError } from "../../application/errors";
import { DomainError } from "../../domain/shared/domain-error";

/** What the consumer does with a message whose processing failed (spec 3.14). */
export type MessageFailure =
  /** Terminal for the provider: logged and counted where it happened, then the message is deleted. */
  | { readonly kind: "business"; readonly code: string }
  /** Retrying cannot help: the message goes to the dead-letter queue at once. */
  | { readonly kind: "permanent"; readonly reason: string; readonly code: string }
  /** Retried with backoff until the redrive policy moves it to the dead-letter queue. */
  | { readonly kind: "transient" };

const BUSINESS_CODES: ReadonlySet<string> = new Set(["IDEMPOTENCY_KEY_CONFLICT", "EXTERNAL_TRANSACTION_CONFLICT"]);

/** Application error codes that no retry can fix, with the `reason` reported on the dead-lettered message. */
const PERMANENT_REASONS: Readonly<Record<string, string>> = {
  VALIDATION_FAILED: "invalid_message",
  WALLET_NOT_FOUND: "wallet_not_found",
  INBOX_PAYLOAD_MISMATCH: "inbox_payload_mismatch",
  INTEGRITY_VIOLATION: "integrity_violation",
};

/** An unparsable body or an envelope that fails validation. */
export const INVALID_MESSAGE: MessageFailure = {
  kind: "permanent",
  reason: "invalid_message",
  code: "VALIDATION_FAILED",
};

/**
 * Unknown errors are transient on purpose: a wrong "permanent" guess would dead-letter a recoverable message, while a
 * wrong "transient" guess costs only the retries before the redrive policy moves it anyway.
 */
export function classifyMessageFailure(error: unknown): MessageFailure {
  if (error instanceof ApplicationError) {
    if (BUSINESS_CODES.has(error.code)) return { kind: "business", code: error.code };
    const reason = PERMANENT_REASONS[error.code];
    return reason ? { kind: "permanent", reason, code: error.code } : { kind: "transient" };
  }
  if (error instanceof DomainError) {
    return { kind: "permanent", reason: "domain_rule_violation", code: error.code };
  }
  return { kind: "transient" };
}

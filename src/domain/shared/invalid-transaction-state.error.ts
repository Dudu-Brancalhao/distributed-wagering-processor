import { DomainError } from "./domain-error";

/** A transition was attempted from a state that does not allow it. This is a programming error, not a business path. */
export class InvalidTransactionStateError extends DomainError {
  readonly code = "INVALID_TRANSACTION_STATE";
}

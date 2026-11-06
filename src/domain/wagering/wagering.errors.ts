import { DomainError } from "../shared/domain-error";

/** The transaction request breaks a structural rule (kind, reference, amount). Maps to VALIDATION_FAILED. */
export class InvalidWagerTransactionError extends DomainError {
  readonly code = "INVALID_WAGER_TRANSACTION";
}

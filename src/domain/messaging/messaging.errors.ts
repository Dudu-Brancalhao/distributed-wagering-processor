import { DomainError } from "../shared/domain-error";

export class InvalidMessageStateError extends DomainError {
  readonly code = "INVALID_MESSAGE_STATE";
}

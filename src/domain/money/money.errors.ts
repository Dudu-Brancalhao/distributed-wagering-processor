import { DomainError } from "../shared/domain-error";

export class InvalidMoneyError extends DomainError {
  readonly code = "INVALID_MONEY";
}

export class CurrencyMismatchError extends DomainError {
  readonly code = "CURRENCY_MISMATCH";

  constructor(expected: string, actual: string) {
    super(`Currency mismatch: expected ${expected}, got ${actual}`);
  }
}

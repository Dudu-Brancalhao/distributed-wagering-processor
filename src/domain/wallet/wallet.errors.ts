import { DomainError } from "../shared/domain-error";

export class InsufficientFundsError extends DomainError {
  readonly code = "INSUFFICIENT_FUNDS";
}

export class InvalidLedgerEntryError extends DomainError {
  readonly code = "INVALID_LEDGER_ENTRY";
}

export class InvalidWalletError extends DomainError {
  readonly code = "INVALID_WALLET";
}

/** Stable, machine-readable reasons stored on REJECTED and FAILED transactions (spec 3.12). */
export enum FailureCode {
  InsufficientFunds = "INSUFFICIENT_FUNDS",
  ReversalInsufficientFunds = "REVERSAL_INSUFFICIENT_FUNDS",
  CurrencyMismatch = "CURRENCY_MISMATCH",
  PlayerWalletMismatch = "PLAYER_WALLET_MISMATCH",
  ReferenceNotFound = "REFERENCE_NOT_FOUND",
  ReferenceKindNotAllowed = "REFERENCE_KIND_NOT_ALLOWED",
  ReferenceScopeMismatch = "REFERENCE_SCOPE_MISMATCH",
  ReferenceNotProcessed = "REFERENCE_NOT_PROCESSED",
  ReferenceAlreadyReversed = "REFERENCE_ALREADY_REVERSED",
  ReversalAmountMismatch = "REVERSAL_AMOUNT_MISMATCH",
  /** FAILED only: permanent non-business error while retrying a pending reference. */
  ProcessingFailed = "PROCESSING_FAILED",
}

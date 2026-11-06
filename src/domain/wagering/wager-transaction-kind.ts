export enum WagerTransactionKind {
  /** Internal: opening credit of a wallet. Never accepted from providers. */
  Opening = "OPENING",
  Bet = "BET",
  Win = "WIN",
  Loss = "LOSS",
  Refund = "REFUND",
  Rollback = "ROLLBACK",
}

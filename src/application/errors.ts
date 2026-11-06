/** Base class for errors the application reports to its driving adapters. `code` is a stable machine identifier. */
export abstract class ApplicationError extends Error {
  abstract readonly code: string;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export interface FieldIssue {
  readonly path: string;
  readonly message: string;
}

/** The request itself is malformed. */
export class ValidationError extends ApplicationError {
  readonly code = "VALIDATION_FAILED";

  constructor(
    message: string,
    readonly issues: readonly FieldIssue[] = [],
  ) {
    super(message);
  }
}

/** The idempotency key was already used with a different payload. */
export class IdempotencyConflictError extends ApplicationError {
  readonly code = "IDEMPOTENCY_KEY_CONFLICT";
}

/** The (providerId, externalTransactionId) pair already exists under another idempotency key. */
export class ExternalTransactionConflictError extends ApplicationError {
  readonly code = "EXTERNAL_TRANSACTION_CONFLICT";
}

/**
 * The wallet does not exist. `lookup` tells whether it was the requested resource itself or a wallet referenced by
 * an operation, because adapters report those differently (missing resource versus business rejection).
 */
export class WalletNotFoundError extends ApplicationError {
  readonly code = "WALLET_NOT_FOUND";

  constructor(
    readonly walletId: string,
    readonly lookup: "resource" | "reference",
  ) {
    super(`Wallet ${walletId} does not exist`);
  }
}

export class WalletAlreadyExistsError extends ApplicationError {
  readonly code = "WALLET_ALREADY_EXISTS";

  constructor(readonly walletId: string) {
    super(`A wallet for this player and currency already exists: ${walletId}`);
  }
}

export class TransactionNotFoundError extends ApplicationError {
  readonly code = "TRANSACTION_NOT_FOUND";
}

export type DuplicateRecordKind = "idempotency_key" | "external_transaction" | "reversal" | "wallet_player_currency";

/** A concurrent writer committed a row with the same unique key first; the SQL transaction is aborted. */
export class DuplicateRecordError extends ApplicationError {
  readonly code = "DUPLICATE_RECORD";

  constructor(
    readonly kind: DuplicateRecordKind,
    options?: ErrorOptions,
  ) {
    super(`Concurrent write conflict on ${kind}`, options);
  }
}

/**
 * The database rejected a write with an integrity or data error outside the documented unique-key races (spec 3.10):
 * a bug or a numeric overflow. Retrying cannot fix it.
 */
export class IntegrityViolationError extends ApplicationError {
  readonly code = "INTEGRITY_VIOLATION";
}

export type TransientReason = "lock_timeout" | "database_unavailable" | "unique_race";

/** A temporary infrastructure failure. Nothing was committed; retrying with the same idempotency key is safe. */
export class TransientInfrastructureError extends ApplicationError {
  readonly code = "SERVICE_UNAVAILABLE";

  constructor(
    message: string,
    readonly reason: TransientReason,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

import {
  ApplicationError,
  DuplicateRecordError,
  type DuplicateRecordKind,
  IntegrityViolationError,
  TransientInfrastructureError,
} from "../../application/errors";

/** Unique constraints that concurrent writers can legitimately race on (spec 3.8). */
const RACED_UNIQUE_CONSTRAINTS: Readonly<Record<string, DuplicateRecordKind>> = {
  wager_tx_provider_idempotency_uq: "idempotency_key",
  wager_tx_provider_external_uq: "external_transaction",
  wager_tx_single_reversal: "reversal",
  wallets_player_currency_uq: "wallet_player_currency",
};

const UNIQUE_VIOLATION = "23505";
const LOCK_NOT_AVAILABLE = "55P03";

/** SQLSTATE class 23: integrity constraint violations, including the guard triggers' `restrict_violation`. */
const INTEGRITY_VIOLATION_CLASS = "23";
/** Data exceptions that validation cannot prevent: string too long (22001) and numeric overflow (22003). */
const DATA_EXCEPTION_SQLSTATES: ReadonlySet<string> = new Set(["22001", "22003"]);

/** Server-side SQLSTATEs that are temporary: retrying the same unit of work can succeed. */
const TRANSIENT_SQLSTATES: ReadonlySet<string> = new Set([
  "40P01", // deadlock detected
  "40001", // serialization failure
  "57014", // statement timeout
  "25P03", // idle in transaction session timeout
  "25P04", // transaction timeout
  "53300", // too many connections
  "57P01", // admin shutdown
  "57P02", // crash shutdown
  "57P03", // cannot connect now
]);

/** Client-side failures of the `pg` driver: unreachable, frozen or restarting server. */
const CLIENT_FAILURE_MARKERS = [
  "Query read timeout",
  "timeout exceeded when trying to connect",
  "Connection terminated",
  "Client has encountered a connection error",
  "ECONNREFUSED",
  "ECONNRESET",
];

interface DatabaseErrorShape {
  readonly code?: unknown;
  readonly constraint?: unknown;
  readonly message?: unknown;
}

/** Maps a PostgreSQL or `pg` client error to an application error; anything unrecognized is returned unchanged. */
export function classifyDatabaseError(error: unknown): unknown {
  if (error instanceof ApplicationError || !(error instanceof Error)) return error;
  const { code, constraint, message } = error as DatabaseErrorShape;
  if (code === UNIQUE_VIOLATION && typeof constraint === "string" && constraint in RACED_UNIQUE_CONSTRAINTS) {
    return new DuplicateRecordError(RACED_UNIQUE_CONSTRAINTS[constraint] as DuplicateRecordKind, { cause: error });
  }
  if (code === LOCK_NOT_AVAILABLE) {
    return new TransientInfrastructureError("Timed out waiting for a row lock", "lock_timeout", { cause: error });
  }
  if (typeof code === "string" && (TRANSIENT_SQLSTATES.has(code) || code.startsWith("08"))) {
    return new TransientInfrastructureError(`Transient database error ${code}`, "database_unavailable", {
      cause: error,
    });
  }
  if (typeof code === "string" && (code.startsWith(INTEGRITY_VIOLATION_CLASS) || DATA_EXCEPTION_SQLSTATES.has(code))) {
    return new IntegrityViolationError(`Database integrity error ${code}`, { cause: error });
  }
  if (isClientFailure(code, message)) {
    return new TransientInfrastructureError("Database unreachable", "database_unavailable", { cause: error });
  }
  return error;
}

/** Runs a database call and rethrows its failure as classified by `classifyDatabaseError`. */
export async function withDatabaseErrors<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    throw classifyDatabaseError(error);
  }
}

function isClientFailure(code: unknown, message: unknown): boolean {
  const text = `${typeof code === "string" ? code : ""} ${typeof message === "string" ? message : ""}`;
  return CLIENT_FAILURE_MARKERS.some((marker) => text.includes(marker));
}

import { HttpException, HttpStatus } from "@nestjs/common";
import {
  ApplicationError,
  TransientInfrastructureError,
  ValidationError,
  WalletAlreadyExistsError,
  WalletNotFoundError,
} from "../../application/errors";
import { InvalidMoneyError } from "../../domain/money/money.errors";
import { InvalidWagerTransactionError } from "../../domain/wagering/wagering.errors";

export interface ErrorBody {
  readonly code: string;
  readonly message: string;
  readonly details?: unknown;
}

export interface HttpErrorResponse {
  readonly status: number;
  readonly body: ErrorBody;
  readonly headers: Readonly<Record<string, string>>;
}

const RETRY_AFTER_SECONDS = "1";

const STATUS_BY_CODE: Readonly<Record<string, number>> = {
  VALIDATION_FAILED: HttpStatus.BAD_REQUEST,
  IDEMPOTENCY_KEY_CONFLICT: HttpStatus.CONFLICT,
  EXTERNAL_TRANSACTION_CONFLICT: HttpStatus.CONFLICT,
  WALLET_ALREADY_EXISTS: HttpStatus.CONFLICT,
  TRANSACTION_NOT_FOUND: HttpStatus.NOT_FOUND,
  SERVICE_UNAVAILABLE: HttpStatus.SERVICE_UNAVAILABLE,
};

/** Maps any error to the HTTP status and body of spec 3.12/3.13. Unknown errors are a 500 without internals. */
export function toHttpError(error: unknown): HttpErrorResponse {
  if (error instanceof InvalidMoneyError || error instanceof InvalidWagerTransactionError) {
    return respond(HttpStatus.BAD_REQUEST, { code: "VALIDATION_FAILED", message: error.message });
  }
  if (error instanceof ApplicationError) {
    return fromApplicationError(error);
  }
  if (error instanceof HttpException) {
    return fromFrameworkError(error);
  }
  return respond(HttpStatus.INTERNAL_SERVER_ERROR, { code: "INTERNAL_ERROR", message: "Unexpected error" });
}

function fromApplicationError(error: ApplicationError): HttpErrorResponse {
  if (error instanceof ValidationError) {
    return respond(HttpStatus.BAD_REQUEST, { code: error.code, message: error.message, details: error.issues });
  }
  if (error instanceof WalletNotFoundError) {
    const status = error.lookup === "resource" ? HttpStatus.NOT_FOUND : HttpStatus.UNPROCESSABLE_ENTITY;
    return respond(status, { code: error.code, message: error.message });
  }
  if (error instanceof WalletAlreadyExistsError) {
    return respond(HttpStatus.CONFLICT, {
      code: error.code,
      message: error.message,
      details: { walletId: error.walletId },
    });
  }
  if (error instanceof TransientInfrastructureError) {
    return respond(
      HttpStatus.SERVICE_UNAVAILABLE,
      { code: error.code, message: "Temporarily unavailable, retry with the same idempotency key" },
      { "Retry-After": RETRY_AFTER_SECONDS },
    );
  }
  const status = STATUS_BY_CODE[error.code];
  if (status === undefined) {
    return respond(HttpStatus.INTERNAL_SERVER_ERROR, { code: "INTERNAL_ERROR", message: "Unexpected error" });
  }
  return respond(status, { code: error.code, message: error.message });
}

/** Errors raised by Nest itself: unparsable JSON body (400), unknown route (404), oversized body (413). */
function fromFrameworkError(error: HttpException): HttpErrorResponse {
  const status = error.getStatus();
  if (status === HttpStatus.BAD_REQUEST) {
    return respond(status, { code: "VALIDATION_FAILED", message: "Malformed request" });
  }
  if (status === HttpStatus.NOT_FOUND) {
    return respond(status, { code: "ROUTE_NOT_FOUND", message: "No such route" });
  }
  if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
    return respond(HttpStatus.INTERNAL_SERVER_ERROR, { code: "INTERNAL_ERROR", message: "Unexpected error" });
  }
  return respond(status, { code: "REQUEST_REJECTED", message: error.message });
}

function respond(status: number, body: ErrorBody, headers: Record<string, string> = {}): HttpErrorResponse {
  return { status, body, headers };
}

import { type ArgumentsHost, Catch, type ExceptionFilter, HttpStatus, Inject } from "@nestjs/common";
import type { Response } from "express";
import type { AppLogger } from "../../application/ports/app-logger.port";
import { APP_LOGGER } from "../../infrastructure/observability/observability.tokens";
import { toHttpError } from "./http-error-mapping";

/** Renders every error as `{ code, message, details? }` with the status of spec 3.13. */
@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  constructor(@Inject(APP_LOGGER) private readonly logger: AppLogger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const { status, body, headers } = toHttpError(exception);
    if (status === HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logUnexpected(exception);
    }
    host.switchToHttp().getResponse<Response>().status(status).set(headers).json(body);
  }

  /** Only the error class and SQLSTATE: driver messages can embed query parameters (player ids, amounts). */
  private logUnexpected(exception: unknown): void {
    const errorName = exception instanceof Error ? exception.name : typeof exception;
    const sqlState = (exception as { code?: unknown } | null)?.code;
    this.logger.error("unexpected error while handling a request", {
      event: "http.unexpected_error",
      errorName,
      sqlState: typeof sqlState === "string" ? sqlState : undefined,
    });
  }
}

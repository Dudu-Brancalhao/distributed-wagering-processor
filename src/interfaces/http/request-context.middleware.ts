import type { NestMiddleware } from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";
import { LogContext } from "../../infrastructure/observability/log-context";

const CORRELATION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

/** Assigns correlation and request ids to every HTTP request, echoes them, and scopes them for logging. */
export class RequestContextMiddleware implements NestMiddleware {
  use(request: Request, response: Response, next: NextFunction): void {
    const incoming = request.header("x-correlation-id");
    const correlationId = incoming && CORRELATION_ID_PATTERN.test(incoming) ? incoming : Bun.randomUUIDv7();
    const requestId = Bun.randomUUIDv7();
    response.setHeader("X-Correlation-Id", correlationId);
    response.setHeader("X-Request-Id", requestId);
    LogContext.run({ correlationId, requestId }, next);
  }
}

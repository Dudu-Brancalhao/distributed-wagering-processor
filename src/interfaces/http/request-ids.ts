import { createParamDecorator, type ExecutionContext } from "@nestjs/common";
import type { Response } from "express";

/** Correlation and request ids assigned by `RequestContextMiddleware`. */
export interface RequestIds {
  readonly correlationId: string;
  readonly requestId: string;
}

const LOCALS_KEY = "requestIds";

export function storeRequestIds(response: Response, ids: RequestIds): void {
  response.locals[LOCALS_KEY] = ids;
}

/** Injects the request's `RequestIds` into a controller method. */
export const CurrentRequestIds = createParamDecorator((_data: unknown, context: ExecutionContext): RequestIds => {
  return context.switchToHttp().getResponse<Response>().locals[LOCALS_KEY] as RequestIds;
});

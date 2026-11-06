import { createParamDecorator, type ExecutionContext } from "@nestjs/common";
import type { Request } from "express";
import { ValidationError } from "../../application/errors";
import { idempotencyKeyField } from "../shared/input-formats";

const HEADER = "Idempotency-Key";

/** The mandatory `Idempotency-Key` header, validated; a missing or malformed key is VALIDATION_FAILED. */
export const IdempotencyKey = createParamDecorator((_data: unknown, context: ExecutionContext): string => {
  const value = context.switchToHttp().getRequest<Request>().header(HEADER);
  const parsed = idempotencyKeyField.safeParse(value);
  if (!parsed.success) {
    const message = value === undefined ? "required" : (parsed.error.issues[0]?.message ?? "invalid");
    throw new ValidationError("Invalid Idempotency-Key header", [{ path: HEADER, message }]);
  }
  return parsed.data;
});

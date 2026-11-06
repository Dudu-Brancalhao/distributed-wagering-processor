import { StandardSchemaValidationPipe, type StandardSchemaValidationPipeOptions } from "@nestjs/common";
import { type FieldIssue, ValidationError } from "../../application/errors";

type SchemaIssue = Parameters<NonNullable<StandardSchemaValidationPipeOptions["exceptionFactory"]>>[0][number];

/** Validates `{ schema }` parameters (Zod) and reports failures as VALIDATION_FAILED with field details. */
export function createValidationPipe(): StandardSchemaValidationPipe {
  return new StandardSchemaValidationPipe({
    exceptionFactory: (issues) => new ValidationError("Request validation failed", issues.map(toFieldIssue)),
  });
}

export function toFieldIssue(issue: SchemaIssue): FieldIssue {
  const path = (issue.path ?? []).map((segment) => String(typeof segment === "object" ? segment.key : segment));
  return { path: path.join("."), message: issue.message };
}

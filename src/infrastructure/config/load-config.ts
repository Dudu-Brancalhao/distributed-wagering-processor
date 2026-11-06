import { z } from "zod";

export class InvalidConfigError extends Error {
  constructor(issues: string) {
    super(`Invalid configuration:\n${issues}`);
    this.name = "InvalidConfigError";
  }
}

/** Parses environment variables against a schema and fails fast with a readable list of problems. */
export function loadConfig<Schema extends z.ZodType>(
  schema: Schema,
  env: Record<string, string | undefined> = process.env,
): z.infer<Schema> {
  const result = schema.safeParse(env);
  if (!result.success) {
    throw new InvalidConfigError(z.prettifyError(result.error));
  }
  return result.data;
}

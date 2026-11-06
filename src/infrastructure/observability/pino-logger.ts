import pino, { type Logger } from "pino";
import type { AppLogger, LogFields } from "../../application/ports/app-logger.port";
import { LogContext } from "./log-context";

export interface LoggerOptions {
  readonly level: string;
  readonly instanceId: string;
  readonly roles: readonly string[];
  readonly destination?: pino.DestinationStream;
}

/** Defense in depth: these keys are removed even if a caller passes them by mistake. */
export const REDACTED_KEYS = [
  "amount",
  "balance",
  "money",
  "playerId",
  "payload",
  "body",
  "idempotencyKey",
  "receiptHandle",
  "headers",
] as const;

export function createPino(options: LoggerOptions): Logger {
  return pino(
    {
      level: options.level,
      base: { instanceId: options.instanceId, roles: options.roles.join(",") },
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: { level: (label) => ({ level: label }) },
      redact: { paths: [...REDACTED_KEYS], remove: true },
      mixin: () => ({ ...LogContext.current() }),
    },
    options.destination ?? pino.destination({ sync: true }),
  );
}

export class PinoAppLogger implements AppLogger {
  constructor(private readonly logger: Logger) {}

  debug(message: string, fields?: LogFields): void {
    this.logger.debug(fields ?? {}, message);
  }

  info(message: string, fields?: LogFields): void {
    this.logger.info(fields ?? {}, message);
  }

  warn(message: string, fields?: LogFields): void {
    this.logger.warn(fields ?? {}, message);
  }

  error(message: string, fields?: LogFields): void {
    this.logger.error(fields ?? {}, message);
  }
}

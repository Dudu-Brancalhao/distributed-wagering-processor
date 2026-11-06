import pino, { type Logger } from "pino";
import type { AppLogger, LogFields } from "../../application/ports/app-logger.port";
import { LogContext } from "./log-context";

export interface LoggerOptions {
  readonly level: string;
  readonly instanceId: string;
  readonly roles: readonly string[];
  readonly destination?: pino.DestinationStream;
}

export function createPino(options: LoggerOptions): Logger {
  return pino(
    {
      level: options.level,
      base: { instanceId: options.instanceId, roles: options.roles.join(",") },
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: { level: (label) => ({ level: label }) },
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

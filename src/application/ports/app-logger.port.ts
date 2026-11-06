/** Identifiers that may appear on a log line. Never put amounts, balances, player ids or payloads here. */
export interface LogFields {
  readonly event?: string;
  readonly correlationId?: string;
  readonly requestId?: string;
  readonly messageId?: string;
  readonly transactionId?: string;
  readonly walletId?: string;
  readonly providerId?: string;
  readonly [field: string]: string | number | boolean | undefined;
}

export interface AppLogger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

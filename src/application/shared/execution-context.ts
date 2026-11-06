import type { TransactionSource } from "../ports/wagering-metrics.port";

/** Ids that tie the events and logs of one request or message together. */
export interface EventOrigin {
  readonly correlationId: string;
  /** The HTTP request id or the SQS message id. */
  readonly causationId: string;
}

export interface ExecutionContext extends EventOrigin {
  readonly source: TransactionSource;
}

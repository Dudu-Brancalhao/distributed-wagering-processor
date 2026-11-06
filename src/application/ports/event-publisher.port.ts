import type { OutboxMessage } from "../../domain/messaging/outbox-message";

/** Per-message result of one publish call: the ids that were not accepted, with the reason (never the payload). */
export interface PublishOutcome {
  readonly failures: ReadonlyMap<string, string>;
}

/** Sends committed outbox messages to the events destination. The only way events leave the service (E-06). */
export interface EventPublisher {
  /** Rejects when the call as a whole fails; a partial failure resolves with the failed ids. */
  publish(messages: readonly OutboxMessage[]): Promise<PublishOutcome>;
}

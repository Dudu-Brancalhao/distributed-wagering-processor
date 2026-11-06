import type { OutboxMessage } from "../../domain/messaging/outbox-message";

export interface OutboxRepository {
  /** The write happens when the unit of work commits, together with the change that produced the events. */
  add(messages: readonly OutboxMessage[]): void;
}

import type { OutboxMessage } from "../../domain/messaging/outbox-message";

export interface OutboxRepository {
  /** The write happens when the unit of work commits, together with the change that produced the events. */
  add(messages: readonly OutboxMessage[]): void;
  /**
   * Locks up to `limit` unpublished messages due at `now`, oldest first, skipping rows another transaction holds
   * (`FOR UPDATE SKIP LOCKED`). The locks last until the current transaction ends.
   */
  claimDue(now: Date, limit: number): Promise<OutboxMessage[]>;
  /** Persists the outcome of a publish attempt when the unit of work commits; `lastError` is set on failure only. */
  saveAttempt(message: OutboxMessage, lastError?: string): void;
  /** When the oldest unpublished message occurred, or `undefined` when nothing is waiting. */
  oldestPendingOccurredAt(): Promise<Date | undefined>;
}

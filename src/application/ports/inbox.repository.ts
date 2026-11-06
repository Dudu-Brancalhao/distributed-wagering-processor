import type { InboxMessage } from "../../domain/messaging/inbox-message";

/** Statements run at once inside the open unit of work, so the inbox row commits or rolls back with the effects. */
export interface InboxRepository {
  /**
   * Inserts the row unless one with the same (consumerName, messageId) exists, and then returns that existing row.
   * A concurrent insert of the same key waits for the other transaction to finish first.
   */
  insertIfAbsent(message: InboxMessage): Promise<InboxMessage | undefined>;
  markProcessed(message: InboxMessage): Promise<void>;
}

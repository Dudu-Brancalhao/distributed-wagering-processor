import { OutboxMessage } from "../../../domain/messaging/outbox-message";
import { OutboxMessageRecord } from "../records/outbox-message.record";

/** Length of the `last_error` column. */
const LAST_ERROR_MAX_LENGTH = 512;

export const OutboxMessageMapper = {
  toDomain(record: OutboxMessageRecord): OutboxMessage {
    return OutboxMessage.rehydrate({
      id: record.id,
      aggregateId: record.aggregateId,
      eventType: record.eventType,
      payload: record.payload,
      occurredAt: record.occurredAt,
      attempts: record.attempts,
      nextAttemptAt: record.nextAttemptAt,
      publishedAt: record.publishedAt ?? undefined,
    });
  },

  toRecord(message: OutboxMessage): OutboxMessageRecord {
    return Object.assign(new OutboxMessageRecord(), {
      id: message.id,
      aggregateId: message.aggregateId,
      eventType: message.eventType,
      payload: message.payload,
      occurredAt: message.occurredAt,
      attempts: message.attempts,
      nextAttemptAt: message.nextAttemptAt ?? message.occurredAt,
      publishedAt: message.publishedAt ?? null,
      lastError: null,
    });
  },

  /** The columns a publish attempt changes; `last_error` only when the attempt failed. */
  attemptFields(message: OutboxMessage, lastError?: string): Partial<OutboxMessageRecord> {
    return {
      attempts: message.attempts,
      nextAttemptAt: message.nextAttemptAt ?? message.occurredAt,
      publishedAt: message.publishedAt ?? null,
      ...(lastError === undefined ? {} : { lastError: lastError.slice(0, LAST_ERROR_MAX_LENGTH) }),
    };
  },
};

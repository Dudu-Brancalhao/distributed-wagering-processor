import { EntitySchema } from "@mikro-orm/core";
import type { IntegrationEventEnvelope } from "../../../domain/events/integration-event";

/** Persistence model of a row in `outbox_messages`; `payload` is the event envelope as `jsonb`. */
export class OutboxMessageRecord {
  id!: string;
  aggregateId!: string;
  eventType!: string;
  payload!: IntegrationEventEnvelope<unknown>;
  occurredAt!: Date;
  attempts!: number;
  nextAttemptAt!: Date;
  publishedAt!: Date | null;
  lastError!: string | null;
}

export const OutboxMessageSchema = new EntitySchema<OutboxMessageRecord>({
  class: OutboxMessageRecord,
  tableName: "outbox_messages",
  properties: {
    id: { type: "uuid", primary: true },
    aggregateId: { type: "uuid" },
    eventType: { type: "string", length: 64 },
    payload: { type: "json" },
    occurredAt: { type: "datetime" },
    attempts: { type: "integer" },
    nextAttemptAt: { type: "datetime" },
    publishedAt: { type: "datetime", nullable: true },
    lastError: { type: "string", length: 512, nullable: true },
  },
});

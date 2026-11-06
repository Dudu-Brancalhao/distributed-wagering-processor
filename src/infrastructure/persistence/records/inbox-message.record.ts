import { EntitySchema } from "@mikro-orm/core";

/** Persistence model of a row in `inbox_messages`, keyed by (consumer_name, message_id). */
export class InboxMessageRecord {
  consumerName!: string;
  messageId!: string;
  payloadHash!: string;
  receivedAt!: Date;
  processedAt!: Date | null;
}

export const InboxMessageSchema = new EntitySchema<InboxMessageRecord>({
  class: InboxMessageRecord,
  tableName: "inbox_messages",
  properties: {
    consumerName: { type: "string", length: 64, primary: true },
    messageId: { type: "string", length: 128, primary: true },
    payloadHash: { type: "string", length: 64 },
    receivedAt: { type: "datetime" },
    processedAt: { type: "datetime", nullable: true },
  },
});

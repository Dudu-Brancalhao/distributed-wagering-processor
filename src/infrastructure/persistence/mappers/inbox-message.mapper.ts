import { InboxMessage } from "../../../domain/messaging/inbox-message";
import { InboxMessageRecord } from "../records/inbox-message.record";

export const InboxMessageMapper = {
  toDomain(record: InboxMessageRecord): InboxMessage {
    return InboxMessage.rehydrate({
      consumerName: record.consumerName,
      messageId: record.messageId,
      payloadHash: record.payloadHash,
      receivedAt: record.receivedAt,
      processedAt: record.processedAt ?? undefined,
    });
  },

  toRecord(message: InboxMessage): InboxMessageRecord {
    return Object.assign(new InboxMessageRecord(), {
      consumerName: message.consumerName,
      messageId: message.messageId,
      payloadHash: message.payloadHash,
      receivedAt: message.receivedAt,
      processedAt: message.processedAt ?? null,
    });
  },
};

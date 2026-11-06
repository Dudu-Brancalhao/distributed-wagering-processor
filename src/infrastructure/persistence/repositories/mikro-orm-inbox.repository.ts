import type { EntityManager } from "@mikro-orm/postgresql";
import type { InboxRepository } from "../../../application/ports/inbox.repository";
import type { InboxMessage } from "../../../domain/messaging/inbox-message";
import { InboxMessageMapper } from "../mappers/inbox-message.mapper";
import { InboxMessageRecord } from "../records/inbox-message.record";

/** Uses query builders, which run immediately on the open transaction, instead of the unit-of-work flush. */
export class MikroOrmInboxRepository implements InboxRepository {
  constructor(private readonly em: EntityManager) {}

  async insertIfAbsent(message: InboxMessage): Promise<InboxMessage | undefined> {
    const inserted = await this.em
      .createQueryBuilder(InboxMessageRecord)
      .insert(InboxMessageMapper.toRecord(message))
      .onConflict(["consumerName", "messageId"])
      .ignore()
      .execute("run");
    if (inserted.affectedRows > 0) return undefined;
    const existing = await this.em.findOneOrFail(InboxMessageRecord, {
      consumerName: message.consumerName,
      messageId: message.messageId,
    });
    return InboxMessageMapper.toDomain(existing);
  }

  async markProcessed(message: InboxMessage): Promise<void> {
    await this.em
      .createQueryBuilder(InboxMessageRecord)
      .update({ processedAt: message.processedAt ?? null })
      .where({ consumerName: message.consumerName, messageId: message.messageId })
      .execute("run");
  }
}

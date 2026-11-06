import { LockMode, QueryOrder } from "@mikro-orm/core";
import type { EntityManager } from "@mikro-orm/postgresql";
import type { OutboxRepository } from "../../../application/ports/outbox.repository";
import type { OutboxMessage } from "../../../domain/messaging/outbox-message";
import { OutboxMessageMapper } from "../mappers/outbox-message.mapper";
import { withDatabaseErrors } from "../pg-error-classifier";
import { OutboxMessageRecord } from "../records/outbox-message.record";

export class MikroOrmOutboxRepository implements OutboxRepository {
  constructor(private readonly em: EntityManager) {}

  add(messages: readonly OutboxMessage[]): void {
    for (const message of messages) {
      this.em.persist(OutboxMessageMapper.toRecord(message));
    }
  }

  /** `PESSIMISTIC_PARTIAL_WRITE` renders `FOR UPDATE SKIP LOCKED`; it needs the open transaction it locks for. */
  async claimDue(now: Date, limit: number): Promise<OutboxMessage[]> {
    const records = await withDatabaseErrors(() =>
      this.em.find(
        OutboxMessageRecord,
        { publishedAt: null, nextAttemptAt: { $lte: now } },
        {
          orderBy: { occurredAt: QueryOrder.ASC, id: QueryOrder.ASC },
          limit,
          lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE,
          refresh: true,
        },
      ),
    );
    return records.map((record) => OutboxMessageMapper.toDomain(record));
  }

  saveAttempt(message: OutboxMessage, lastError?: string): void {
    this.em.assign(
      this.em.getReference(OutboxMessageRecord, message.id),
      OutboxMessageMapper.attemptFields(message, lastError),
    );
  }

  async oldestPendingOccurredAt(): Promise<Date | undefined> {
    const oldest = await withDatabaseErrors(() =>
      this.em.findOne(
        OutboxMessageRecord,
        { publishedAt: null },
        { orderBy: { occurredAt: QueryOrder.ASC }, fields: ["occurredAt"], disableIdentityMap: true },
      ),
    );
    return oldest?.occurredAt;
  }
}

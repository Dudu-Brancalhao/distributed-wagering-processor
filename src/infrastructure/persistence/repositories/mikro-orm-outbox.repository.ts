import type { EntityManager } from "@mikro-orm/postgresql";
import type { OutboxRepository } from "../../../application/ports/outbox.repository";
import type { OutboxMessage } from "../../../domain/messaging/outbox-message";
import { OutboxMessageMapper } from "../mappers/outbox-message.mapper";

export class MikroOrmOutboxRepository implements OutboxRepository {
  constructor(private readonly em: EntityManager) {}

  add(messages: readonly OutboxMessage[]): void {
    for (const message of messages) {
      this.em.persist(OutboxMessageMapper.toRecord(message));
    }
  }
}

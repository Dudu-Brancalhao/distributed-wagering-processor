import type { FilterQuery } from "@mikro-orm/core";
import type { EntityManager } from "@mikro-orm/postgresql";
import type { WagerTransactionRepository } from "../../../application/ports/wager-transaction.repository";
import type { WagerTransaction } from "../../../domain/wagering/wager-transaction";
import { WagerTransactionKind } from "../../../domain/wagering/wager-transaction-kind";
import { WagerTransactionStatus } from "../../../domain/wagering/wager-transaction-status";
import { WagerTransactionMapper } from "../mappers/wager-transaction.mapper";
import { withDatabaseErrors } from "../pg-error-classifier";
import { WagerTransactionRecord } from "../records/wager-transaction.record";
import { WalletRecord } from "../records/wallet.record";

const REVERSAL_KINDS = [WagerTransactionKind.Refund, WagerTransactionKind.Rollback];

export class MikroOrmWagerTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly em: EntityManager) {}

  findById(transactionId: string): Promise<WagerTransaction | undefined> {
    return this.findOne({ id: transactionId });
  }

  findByIdempotencyKey(providerId: string, idempotencyKey: string): Promise<WagerTransaction | undefined> {
    return this.findOne({ providerId, idempotencyKey });
  }

  findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined> {
    return this.findOne({ providerId, externalTransactionId });
  }

  async hasProcessedReversal(referenceTransactionId: string): Promise<boolean> {
    const count = await withDatabaseErrors(() =>
      this.em.count(WagerTransactionRecord, {
        referenceTransactionId,
        kind: { $in: REVERSAL_KINDS },
        status: WagerTransactionStatus.Processed,
      }),
    );
    return count > 0;
  }

  add(transaction: WagerTransaction): void {
    const wallet = this.em.getReference(WalletRecord, transaction.walletId);
    this.em.persist(WagerTransactionMapper.toRecord(transaction, wallet));
  }

  private async findOne(where: FilterQuery<WagerTransactionRecord>): Promise<WagerTransaction | undefined> {
    const record = await withDatabaseErrors(() => this.em.findOne(WagerTransactionRecord, where));
    return record ? WagerTransactionMapper.toDomain(record) : undefined;
  }
}

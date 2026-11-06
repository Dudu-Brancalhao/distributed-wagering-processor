import { LockMode } from "@mikro-orm/core";
import type { EntityManager } from "@mikro-orm/postgresql";
import type { WalletRepository } from "../../../application/ports/wallet.repository";
import type { Wallet } from "../../../domain/wallet/wallet";
import { WalletMapper } from "../mappers/wallet.mapper";
import { withDatabaseErrors } from "../pg-error-classifier";
import { WalletRecord } from "../records/wallet.record";

export class MikroOrmWalletRepository implements WalletRepository {
  constructor(private readonly em: EntityManager) {}

  findById(walletId: string): Promise<Wallet | undefined> {
    return this.findOne({ id: walletId });
  }

  findByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | undefined> {
    return this.findOne({ playerId, currency });
  }

  lockById(walletId: string): Promise<Wallet | undefined> {
    return this.findOne({ id: walletId }, { lockMode: LockMode.PESSIMISTIC_WRITE, refresh: true });
  }

  add(wallet: Wallet): void {
    this.em.persist(WalletMapper.toRecord(wallet));
  }

  updateBalance(wallet: Wallet): void {
    this.em.assign(this.em.getReference(WalletRecord, wallet.id), WalletMapper.mutableFields(wallet));
  }

  private async findOne(
    where: Partial<Pick<WalletRecord, "id" | "playerId" | "currency">>,
    options: { lockMode?: LockMode.PESSIMISTIC_WRITE; refresh?: boolean } = {},
  ): Promise<Wallet | undefined> {
    const record = await withDatabaseErrors(() => this.em.findOne(WalletRecord, where, options));
    return record ? WalletMapper.toDomain(record) : undefined;
  }
}

import { Money } from "../../../domain/money/money";
import { Wallet } from "../../../domain/wallet/wallet";
import { WalletRecord } from "../records/wallet.record";

export const WalletMapper = {
  toDomain(record: WalletRecord): Wallet {
    return Wallet.rehydrate({
      id: record.id,
      playerId: record.playerId,
      currency: record.currency,
      balance: Money.rehydrate({ amount: record.balance, currency: record.currency }),
      version: record.version,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    });
  },

  toRecord(wallet: Wallet): WalletRecord {
    return Object.assign(new WalletRecord(), WalletMapper.mutableFields(wallet), {
      id: wallet.id,
      playerId: wallet.playerId,
      currency: wallet.currency,
      createdAt: wallet.createdAt,
    });
  },

  /** The columns a balance change may update. */
  mutableFields(wallet: Wallet): Pick<WalletRecord, "balance" | "version" | "updatedAt"> {
    return { balance: wallet.balance.amount, version: wallet.version, updatedAt: wallet.updatedAt };
  },
};

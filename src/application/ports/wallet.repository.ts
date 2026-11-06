import type { Wallet } from "../../domain/wallet/wallet";

export interface WalletRepository {
  findById(walletId: string): Promise<Wallet | undefined>;
  findByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | undefined>;
  /** Reads the wallet with a row lock held until the end of the current transaction (`SELECT ... FOR UPDATE`). */
  lockById(walletId: string): Promise<Wallet | undefined>;
  /** Writes happen when the unit of work commits. */
  add(wallet: Wallet): void;
  updateBalance(wallet: Wallet): void;
}

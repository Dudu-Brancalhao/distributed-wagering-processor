import type { WalletLedgerEntry } from "../../domain/wallet/wallet-ledger-entry";
import { WalletNotFoundError } from "../errors";
import type { LedgerPageQuery, LedgerRepository } from "../ports/ledger.repository";
import type { WalletRepository } from "../ports/wallet.repository";

export interface LedgerPage {
  /** Newest first. */
  readonly entries: readonly WalletLedgerEntry[];
  /** Whether older entries exist beyond this page. */
  readonly hasMore: boolean;
}

/** Pages through a wallet's ledger by wallet version, which is stable because the ledger is append-only. */
export class ListWalletLedger {
  constructor(
    private readonly wallets: WalletRepository,
    private readonly ledger: LedgerRepository,
  ) {}

  async execute(query: LedgerPageQuery): Promise<LedgerPage> {
    if (!(await this.wallets.findById(query.walletId))) {
      throw new WalletNotFoundError(query.walletId, "resource");
    }
    const entries = await this.ledger.listByWallet({ ...query, limit: query.limit + 1 });
    return { entries: entries.slice(0, query.limit), hasMore: entries.length > query.limit };
  }
}

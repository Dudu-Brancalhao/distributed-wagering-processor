import type { WagerTransaction } from "../../domain/wagering/wager-transaction";
import { TransactionNotFoundError } from "../errors";
import type { WagerTransactionRepository } from "../ports/wager-transaction.repository";

/** Reads a transaction by its id or by the provider's external id. */
export class GetWagerTransaction {
  constructor(private readonly transactions: WagerTransactionRepository) {}

  async byId(transactionId: string): Promise<WagerTransaction> {
    return this.found(await this.transactions.findById(transactionId));
  }

  async byExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction> {
    return this.found(await this.transactions.findByExternalId(providerId, externalTransactionId));
  }

  private found(transaction: WagerTransaction | undefined): WagerTransaction {
    if (!transaction) throw new TransactionNotFoundError("The transaction does not exist");
    return transaction;
  }
}

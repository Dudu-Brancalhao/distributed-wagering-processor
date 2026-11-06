import type { Money } from "../../domain/money/money";
import { WagerTransaction } from "../../domain/wagering/wager-transaction";
import { WagerTransactionKind } from "../../domain/wagering/wager-transaction-kind";
import { Wallet } from "../../domain/wallet/wallet";
import type { WalletLedgerEntry } from "../../domain/wallet/wallet-ledger-entry";
import { DuplicateRecordError, WalletAlreadyExistsError } from "../errors";
import type { Clock } from "../ports/clock.port";
import type { IdGenerator } from "../ports/id-generator.port";
import type { LedgerRepository } from "../ports/ledger.repository";
import type { OutboxRepository } from "../ports/outbox.repository";
import type { UnitOfWork } from "../ports/unit-of-work.port";
import type { WagerTransactionRepository } from "../ports/wager-transaction.repository";
import type { WalletRepository } from "../ports/wallet.repository";
import { eventContexts } from "../shared/event-context-factory";
import type { EventOrigin } from "../shared/execution-context";
import { outboxMessagesFor } from "../wagering/outcome-events";
import { PayloadHash } from "../wagering/payload-hash";

/** Provider id of internal transactions; the API's provider id format cannot start with `_`. */
export const SYSTEM_PROVIDER_ID = "_system";
const OPENING_SCOPE = "wallet-opening";

export interface CreateWalletCommand {
  readonly playerId: string;
  readonly initialBalance: Money;
}

export interface CreateWalletDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly wallets: WalletRepository;
  readonly transactions: WagerTransactionRepository;
  readonly ledger: LedgerRepository;
  readonly outbox: OutboxRepository;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

/**
 * Opens a wallet. A positive initial balance is an internal OPENING transaction, already PROCESSED, with its CREDIT
 * entry and events, all in the same SQL transaction as the wallet.
 */
export class CreateWallet {
  constructor(private readonly deps: CreateWalletDependencies) {}

  async execute(command: CreateWalletCommand, origin: EventOrigin): Promise<Wallet> {
    try {
      return await this.deps.unitOfWork.run(async () => this.open(command, origin));
    } catch (error) {
      throw await this.explainDuplicate(error, command);
    }
  }

  private open(command: CreateWalletCommand, origin: EventOrigin): Wallet {
    const now = this.deps.clock.now();
    const openingTransactionId = this.deps.ids.next();
    const { wallet, openingEntry } = Wallet.open({
      id: this.deps.ids.next(),
      playerId: command.playerId,
      initialBalance: command.initialBalance,
      openingTransactionId,
      openingEntryId: this.deps.ids.next(),
      now,
    });
    this.deps.wallets.add(wallet);
    if (openingEntry) {
      this.recordOpening(wallet, openingEntry, openingTransactionId, origin, now);
    }
    return wallet;
  }

  private recordOpening(
    wallet: Wallet,
    entry: WalletLedgerEntry,
    transactionId: string,
    origin: EventOrigin,
    now: Date,
  ): void {
    const fields = {
      providerId: SYSTEM_PROVIDER_ID,
      externalTransactionId: wallet.id,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: OPENING_SCOPE,
      gameId: OPENING_SCOPE,
      kind: WagerTransactionKind.Opening,
      money: entry.money,
    };
    const opening = WagerTransaction.opening(
      {
        ...fields,
        id: transactionId,
        idempotencyKey: `${OPENING_SCOPE}:${wallet.id}`,
        payloadHash: PayloadHash.of(fields),
        correlationId: origin.correlationId,
        createdAt: now,
      },
      { balance: wallet.balance, walletVersion: wallet.version },
    );
    this.deps.transactions.add(opening);
    this.deps.ledger.add(entry);
    this.deps.outbox.add(
      outboxMessagesFor({ transaction: opening, wallet, entry }, eventContexts(this.deps.ids, origin, now)),
    );
  }

  /** A lost race on the player and currency is reported with the id of the wallet that won it. */
  private async explainDuplicate(error: unknown, command: CreateWalletCommand): Promise<unknown> {
    if (!(error instanceof DuplicateRecordError) || error.kind !== "wallet_player_currency") return error;
    const existing = await this.deps.wallets.findByPlayerAndCurrency(command.playerId, command.initialBalance.currency);
    return existing ? new WalletAlreadyExistsError(existing.id) : error;
  }
}

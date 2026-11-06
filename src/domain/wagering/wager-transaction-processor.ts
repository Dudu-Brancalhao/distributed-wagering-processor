import type { RandomSource, RetrySchedule } from "../messaging/retry-schedule";
import { InvalidTransactionStateError } from "../shared/invalid-transaction-state.error";
import { LedgerDirection } from "../wallet/ledger-direction";
import type { Wallet } from "../wallet/wallet";
import { InsufficientFundsError } from "../wallet/wallet.errors";
import type { WalletLedgerEntry } from "../wallet/wallet-ledger-entry";
import { FailureCode } from "./failure-code";
import { ReferencePolicy } from "./reference-policy";
import type { WagerTransaction } from "./wager-transaction";
import { WagerTransactionKind } from "./wager-transaction-kind";
import { WagerTransactionStatus } from "./wager-transaction-status";

export interface ReferenceRetryPolicy {
  readonly schedule: RetrySchedule;
  /** Number of retries after which a still-missing reference rejects the transaction. */
  readonly maxAttempts: number;
}

export interface ProcessingInput {
  readonly transaction: WagerTransaction;
  /** The transaction's wallet, already locked by the caller. */
  readonly wallet: Wallet;
  /** The resolved reference, or undefined when it does not exist (yet). */
  readonly reference?: WagerTransaction;
  /** Whether the reference already has a PROCESSED reversal. */
  readonly referenceAlreadyReversed: boolean;
  /** Id for the ledger entry, used only when the balance moves. */
  readonly entryId: string;
  readonly at: Date;
}

export type ProcessingOutcome =
  | { readonly kind: "applied"; readonly entry?: WalletLedgerEntry }
  | { readonly kind: "rejected"; readonly code: FailureCode }
  | { readonly kind: "awaiting-reference" };

/**
 * Applies the business rules of a transaction to its locked wallet (spec 3.8 steps 8 to 11). Shared by the
 * submit use case (transaction PENDING) and the pending-reference retrier (transaction PENDING_REFERENCE).
 */
export class WagerTransactionProcessor {
  constructor(
    private readonly referenceRetry: ReferenceRetryPolicy,
    private readonly random: RandomSource = Math.random,
  ) {}

  process(input: ProcessingInput): ProcessingOutcome {
    const { transaction, wallet } = input;
    if (transaction.walletId !== wallet.id) {
      throw new InvalidTransactionStateError(`Transaction ${transaction.id} does not target wallet ${wallet.id}`);
    }
    if (transaction.playerId !== wallet.playerId) {
      return this.reject(input, FailureCode.PlayerWalletMismatch);
    }
    if (transaction.money.currency !== wallet.currency) {
      return this.reject(input, FailureCode.CurrencyMismatch);
    }
    if (transaction.hasReference()) {
      if (!input.reference) {
        return this.awaitReference(input, FailureCode.ReferenceNotFound);
      }
      const verdict = ReferencePolicy.evaluate(transaction, input.reference, input.referenceAlreadyReversed);
      if (verdict.kind === "reject") {
        return this.reject(input, verdict.code);
      }
      if (verdict.kind === "await") {
        return this.awaitReference(input, FailureCode.ReferenceNotProcessed);
      }
    }
    return this.apply(input);
  }

  private apply(input: ProcessingInput): ProcessingOutcome {
    const { transaction, wallet, reference } = input;
    let entry: WalletLedgerEntry | undefined;
    if (transaction.affectsBalance()) {
      const direction = transaction.ledgerDirectionFor(reference);
      const movement = {
        entryId: input.entryId,
        transactionId: transaction.id,
        money: transaction.money,
        at: input.at,
      };
      try {
        entry = direction === LedgerDirection.Debit ? wallet.debit(movement) : wallet.credit(movement);
      } catch (error) {
        if (!(error instanceof InsufficientFundsError)) throw error;
        const code =
          transaction.kind === WagerTransactionKind.Rollback
            ? FailureCode.ReversalInsufficientFunds
            : FailureCode.InsufficientFunds;
        return this.reject(input, code);
      }
    }
    transaction.markProcessed({
      at: input.at,
      observation: observe(wallet),
      referenceTransactionId: reference?.id,
    });
    return { kind: "applied", entry };
  }

  private reject(input: ProcessingInput, code: FailureCode): ProcessingOutcome {
    input.transaction.reject(code, { at: input.at, observation: observe(input.wallet) });
    return { kind: "rejected", code };
  }

  /** Enters or stays in PENDING_REFERENCE; rejects with `exhaustedCode` once the retry window is used up. */
  private awaitReference(input: ProcessingInput, exhaustedCode: FailureCode): ProcessingOutcome {
    const { transaction, at } = input;
    const { schedule, maxAttempts } = this.referenceRetry;
    if (transaction.status === WagerTransactionStatus.Pending) {
      transaction.markPendingReference({
        at,
        nextAttemptAt: schedule.nextAttemptAt(0, at, this.random),
        observation: observe(input.wallet),
      });
      return { kind: "awaiting-reference" };
    }
    if (transaction.attempts + 1 >= maxAttempts) {
      transaction.recordFinalReferenceRetry(at);
      return this.reject(input, exhaustedCode);
    }
    transaction.recordReferenceRetry({
      at,
      nextAttemptAt: schedule.nextAttemptAt(transaction.attempts + 1, at, this.random),
    });
    return { kind: "awaiting-reference" };
  }
}

function observe(wallet: Wallet) {
  return { balance: wallet.balance, walletVersion: wallet.version };
}

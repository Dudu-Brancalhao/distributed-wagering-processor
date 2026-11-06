import type { Money } from "../../domain/money/money";
import type { WagerTransaction } from "../../domain/wagering/wager-transaction";
import type { WagerTransactionKind } from "../../domain/wagering/wager-transaction-kind";

/** Kinds a provider may submit; OPENING is internal. */
export type SubmittableKind = Exclude<WagerTransactionKind, WagerTransactionKind.Opening>;

/** A validated provider request (spec 3.8 step 1 already passed): UUIDs lowercased, money parsed. */
export interface SubmitWagerTransactionCommand {
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly idempotencyKey: string;
  readonly playerId: string;
  readonly walletId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: SubmittableKind;
  readonly money: Money;
  readonly referenceExternalTransactionId?: string;
}

export interface SubmitWagerTransactionResult {
  /** The stored transaction; its status, failure code and observed balance are the result. */
  readonly transaction: WagerTransaction;
  readonly idempotentReplay: boolean;
}

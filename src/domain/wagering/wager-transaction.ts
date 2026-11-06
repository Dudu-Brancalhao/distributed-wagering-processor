import type { Money } from "../money/money";
import { InvalidTransactionStateError } from "../shared/invalid-transaction-state.error";
import { LedgerDirection, oppositeDirection } from "../wallet/ledger-direction";
import type { FailureCode } from "./failure-code";
import { WagerTransactionKind } from "./wager-transaction-kind";
import { TERMINAL_STATUSES, WagerTransactionStatus } from "./wager-transaction-status";
import { InvalidWagerTransactionError } from "./wagering.errors";

export interface CreateWagerTransactionProps {
  readonly id: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly correlationId: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: WagerTransactionKind;
  readonly money: Money;
  readonly referenceExternalTransactionId?: string;
  readonly createdAt: Date;
}

export interface WagerTransactionState extends CreateWagerTransactionProps {
  readonly status: WagerTransactionStatus;
  readonly referenceTransactionId?: string;
  readonly failureCode?: FailureCode;
  readonly processedAt?: Date;
  readonly observedBalance?: Money;
  readonly observedWalletVersion?: number;
  readonly attempts: number;
  readonly nextAttemptAt?: Date;
  readonly updatedAt: Date;
}

/** Wallet state seen when the transaction reached its current status; returned by idempotent replays. */
export interface WalletObservation {
  readonly balance: Money;
  readonly walletVersion: number;
}

const REFERENCE_REQUIRED: ReadonlySet<WagerTransactionKind> = new Set([
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
]);
const REFERENCE_FORBIDDEN: ReadonlySet<WagerTransactionKind> = new Set([
  WagerTransactionKind.Opening,
  WagerTransactionKind.Bet,
]);

/**
 * A provider operation on a wallet. Transitions (spec 3.7):
 * PENDING -> PROCESSED | REJECTED | PENDING_REFERENCE | FAILED;
 * PENDING_REFERENCE -> PENDING_REFERENCE (rescheduled) | PROCESSED | REJECTED | FAILED.
 * PROCESSED, REJECTED and FAILED are terminal.
 */
export class WagerTransaction {
  private constructor(
    private readonly props: CreateWagerTransactionProps,
    private _status: WagerTransactionStatus,
    private _attempts: number,
    private _updatedAt: Date,
    private _referenceTransactionId?: string,
    private _failureCode?: FailureCode,
    private _processedAt?: Date,
    private _observedBalance?: Money,
    private _observedWalletVersion?: number,
    private _nextAttemptAt?: Date,
  ) {}

  /** A provider operation. Born PENDING. Rejects OPENING and enforces the reference requirement per kind. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (props.kind === WagerTransactionKind.Opening) {
      throw new InvalidWagerTransactionError("OPENING is internal and cannot be submitted");
    }
    return WagerTransaction.validated(props);
  }

  /** The internal opening credit of a wallet, already applied. */
  static opening(props: Omit<CreateWagerTransactionProps, "kind">, observation: WalletObservation): WagerTransaction {
    const transaction = WagerTransaction.validated({ ...props, kind: WagerTransactionKind.Opening });
    transaction.markProcessed({ at: props.createdAt, observation });
    return transaction;
  }

  /** Rebuilds persisted state without revalidating transitions. */
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state,
      state.status,
      state.attempts,
      state.updatedAt,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt,
      state.observedBalance,
      state.observedWalletVersion,
      state.nextAttemptAt,
    );
  }

  private static validated(props: CreateWagerTransactionProps): WagerTransaction {
    const hasReference = props.referenceExternalTransactionId !== undefined;
    if (REFERENCE_REQUIRED.has(props.kind) && !hasReference) {
      throw new InvalidWagerTransactionError(`${props.kind} requires referenceExternalTransactionId`);
    }
    if (REFERENCE_FORBIDDEN.has(props.kind) && hasReference) {
      throw new InvalidWagerTransactionError(`${props.kind} must not carry a reference`);
    }
    if (props.money.isNegative()) {
      throw new InvalidWagerTransactionError("The amount must not be negative");
    }
    if (props.kind !== WagerTransactionKind.Loss && props.money.isZero()) {
      throw new InvalidWagerTransactionError(`${props.kind} requires a positive amount`);
    }
    return new WagerTransaction(props, WagerTransactionStatus.Pending, 0, props.createdAt);
  }

  get id(): string {
    return this.props.id;
  }
  get providerId(): string {
    return this.props.providerId;
  }
  get externalTransactionId(): string {
    return this.props.externalTransactionId;
  }
  get idempotencyKey(): string {
    return this.props.idempotencyKey;
  }
  get payloadHash(): string {
    return this.props.payloadHash;
  }
  get correlationId(): string {
    return this.props.correlationId;
  }
  get walletId(): string {
    return this.props.walletId;
  }
  get playerId(): string {
    return this.props.playerId;
  }
  get roundId(): string {
    return this.props.roundId;
  }
  get gameId(): string {
    return this.props.gameId;
  }
  get kind(): WagerTransactionKind {
    return this.props.kind;
  }
  get money(): Money {
    return this.props.money;
  }
  get referenceExternalTransactionId(): string | undefined {
    return this.props.referenceExternalTransactionId;
  }
  get createdAt(): Date {
    return this.props.createdAt;
  }
  get status(): WagerTransactionStatus {
    return this._status;
  }
  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }
  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }
  get processedAt(): Date | undefined {
    return this._processedAt;
  }
  get observedBalance(): Money | undefined {
    return this._observedBalance;
  }
  get observedWalletVersion(): number | undefined {
    return this._observedWalletVersion;
  }
  get attempts(): number {
    return this._attempts;
  }
  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }
  get updatedAt(): Date {
    return this._updatedAt;
  }

  markProcessed(params: { at: Date; observation: WalletObservation; referenceTransactionId?: string }): void {
    this.assertNotTerminal("markProcessed");
    if (this.hasReference() && params.referenceTransactionId === undefined) {
      throw new InvalidTransactionStateError(`Transaction ${this.id} needs its resolved reference to be processed`);
    }
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = params.referenceTransactionId;
    this._processedAt = params.at;
    this.settle(params.at, params.observation);
  }

  /** First entry into PENDING_REFERENCE (attempts stay at 0). */
  markPendingReference(params: { at: Date; nextAttemptAt: Date; observation: WalletObservation }): void {
    if (this._status !== WagerTransactionStatus.Pending) {
      throw new InvalidTransactionStateError(`Transaction ${this.id} is ${this._status}, expected PENDING`);
    }
    if (!this.hasReference()) {
      throw new InvalidTransactionStateError(`Transaction ${this.id} has no reference to wait for`);
    }
    this._status = WagerTransactionStatus.PendingReference;
    this._nextAttemptAt = params.nextAttemptAt;
    this.settle(params.at, params.observation);
  }

  /** A retry found no usable reference yet: count it and schedule the next one. */
  recordReferenceRetry(params: { at: Date; nextAttemptAt: Date }): void {
    this.assertPendingReference("recordReferenceRetry");
    this._attempts += 1;
    this._nextAttemptAt = params.nextAttemptAt;
    this._updatedAt = params.at;
  }

  /** Counts a final retry that exhausted the window, right before rejecting. */
  recordFinalReferenceRetry(at: Date): void {
    this.assertPendingReference("recordFinalReferenceRetry");
    this._attempts += 1;
    this._updatedAt = at;
  }

  reject(code: FailureCode, params: { at: Date; observation: WalletObservation }): void {
    this.assertNotTerminal("reject");
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this.settle(params.at, params.observation);
  }

  fail(code: FailureCode, at: Date): void {
    this.assertNotTerminal("fail");
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
    this._nextAttemptAt = undefined;
    this._updatedAt = at;
  }

  isTerminal(): boolean {
    return TERMINAL_STATUSES.has(this._status);
  }

  /** False for LOSS, the only kind that never moves the balance. */
  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return REFERENCE_REQUIRED.has(this.kind);
  }

  hasReference(): boolean {
    return this.referenceExternalTransactionId !== undefined;
  }

  isReversal(): boolean {
    return this.requiresReference();
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /** BET debits; OPENING, WIN and REFUND credit; ROLLBACK takes the opposite direction of its reference. */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Opening:
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Rollback:
        if (!reference) {
          throw new InvalidTransactionStateError("ROLLBACK needs its reference to know the direction");
        }
        return oppositeDirection(reference.ledgerDirectionFor());
      case WagerTransactionKind.Loss:
        throw new InvalidTransactionStateError("LOSS has no ledger direction");
    }
  }

  private settle(at: Date, observation: WalletObservation): void {
    if (this._status !== WagerTransactionStatus.PendingReference) {
      this._nextAttemptAt = undefined;
    }
    this._observedBalance = observation.balance;
    this._observedWalletVersion = observation.walletVersion;
    this._updatedAt = at;
  }

  private assertNotTerminal(transition: string): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(`Cannot ${transition}: transaction ${this.id} is ${this._status}`);
    }
  }

  private assertPendingReference(transition: string): void {
    if (this._status !== WagerTransactionStatus.PendingReference) {
      throw new InvalidTransactionStateError(`Cannot ${transition}: transaction ${this.id} is ${this._status}`);
    }
  }
}

import { RetrySchedule } from "../../../src/domain/messaging/retry-schedule";
import { Money } from "../../../src/domain/money/money";
import { type CreateWagerTransactionProps, WagerTransaction } from "../../../src/domain/wagering/wager-transaction";
import { WagerTransactionKind } from "../../../src/domain/wagering/wager-transaction-kind";
import { WagerTransactionProcessor } from "../../../src/domain/wagering/wager-transaction-processor";
import { Wallet } from "../../../src/domain/wallet/wallet";

export const T0 = new Date("2026-11-06T00:00:00.000Z");
export const PLAYER_ID = "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1";
export const WALLET_ID = "0192f291-27dd-7d3f-8071-5f8685deef37";

let sequence = 0;
export function nextId(prefix = "id"): string {
  sequence += 1;
  return `${prefix}-${sequence}`;
}

export function brl(amount: string): Money {
  return Money.from({ amount, currency: "BRL" });
}

export function walletWith(balance: string, overrides: { id?: string; playerId?: string } = {}): Wallet {
  return Wallet.open({
    id: overrides.id ?? WALLET_ID,
    playerId: overrides.playerId ?? PLAYER_ID,
    initialBalance: brl(balance),
    openingTransactionId: nextId("opening"),
    openingEntryId: nextId("entry"),
    now: T0,
  }).wallet;
}

export function transaction(
  kind: WagerTransactionKind,
  amount: string,
  overrides: Partial<CreateWagerTransactionProps> = {},
): WagerTransaction {
  const externalTransactionId = overrides.externalTransactionId ?? nextId("ext");
  return WagerTransaction.create({
    id: nextId("tx"),
    providerId: "provider-a",
    externalTransactionId,
    idempotencyKey: `provider-a:${externalTransactionId}`,
    payloadHash: "a".repeat(64),
    correlationId: "corr-1",
    walletId: WALLET_ID,
    playerId: PLAYER_ID,
    roundId: "round-987",
    gameId: "fortune-chimp",
    kind,
    money: brl(amount),
    createdAt: T0,
    ...overrides,
  });
}

export const REFERENCE_SCHEDULE = RetrySchedule.of({ baseMs: 1000, capMs: 300_000 });

/** Deterministic processor: no jitter, the decided 20-attempt window. */
export function processor(maxAttempts = 20): WagerTransactionProcessor {
  return new WagerTransactionProcessor({ schedule: REFERENCE_SCHEDULE, maxAttempts }, () => 0.5);
}

export { WagerTransactionKind as Kind };

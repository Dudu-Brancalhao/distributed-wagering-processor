import type { TestApp } from "./test-app";

export const newId = (): string => Bun.randomUUIDv7();

/** A unique provider per call keeps idempotency keys and external ids isolated between tests. */
export const newProviderId = (): string => `provider-${newId().slice(-12)}`;

export interface TestWallet {
  readonly id: string;
  readonly playerId: string;
}

export async function createWallet(app: TestApp, amount: string, currency = "BRL"): Promise<TestWallet> {
  const playerId = newId();
  const response = await app.request("POST", "/wallets", {
    body: { playerId, initialBalance: { amount, currency } },
  });
  if (response.status !== 201) throw new Error(`wallet creation failed: ${JSON.stringify(response.body)}`);
  return { id: response.body.id, playerId };
}

export interface WagerOptions {
  readonly providerId: string;
  readonly wallet: TestWallet;
  readonly kind: string;
  readonly amount: string;
  readonly externalTransactionId?: string;
  readonly referenceExternalTransactionId?: string;
  readonly currency?: string;
  readonly roundId?: string;
}

export function wagerBody(options: WagerOptions) {
  return {
    providerId: options.providerId,
    externalTransactionId: options.externalTransactionId ?? newId(),
    playerId: options.wallet.playerId,
    walletId: options.wallet.id,
    roundId: options.roundId ?? "round-1",
    gameId: "fortune-chimp",
    kind: options.kind,
    money: { amount: options.amount, currency: options.currency ?? "BRL" },
    ...(options.referenceExternalTransactionId === undefined
      ? {}
      : { referenceExternalTransactionId: options.referenceExternalTransactionId }),
  };
}

export type WagerRequestBody = Record<string, unknown> & { providerId?: unknown; externalTransactionId?: unknown };

/** Submits with the recommended default key `{providerId}:{externalTransactionId}` unless one is given. */
export function submit(app: TestApp, body: WagerRequestBody, idempotencyKey?: string) {
  return app.request("POST", "/wagering/transactions", {
    body,
    headers: { "Idempotency-Key": idempotencyKey ?? `${body.providerId}:${body.externalTransactionId}` },
  });
}

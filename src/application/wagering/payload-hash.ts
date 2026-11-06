import { createHash } from "node:crypto";
import type { MoneyProps } from "../../domain/money/money-props";
import { canonicalJson } from "../shared/canonical-json";

/** The business fields of a transaction request; the idempotency key and transport metadata are not part of it. */
export interface WagerPayloadFields {
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly playerId: string;
  readonly walletId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: string;
  readonly money: MoneyProps;
  readonly referenceExternalTransactionId?: string | null;
}

/** Lowercase hex SHA-256 of the canonical JSON of the hashed field subset (spec 3.11). */
export const PayloadHash = {
  of(fields: WagerPayloadFields): string {
    const subset = {
      providerId: fields.providerId,
      externalTransactionId: fields.externalTransactionId,
      playerId: fields.playerId.toLowerCase(),
      walletId: fields.walletId.toLowerCase(),
      roundId: fields.roundId,
      gameId: fields.gameId,
      kind: fields.kind,
      money: { amount: fields.money.amount, currency: fields.money.currency },
      referenceExternalTransactionId: fields.referenceExternalTransactionId ?? undefined,
    };
    return createHash("sha256").update(canonicalJson(subset), "utf8").digest("hex");
  },
};

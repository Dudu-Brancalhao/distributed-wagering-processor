import { EntitySchema } from "@mikro-orm/core";
import { WalletRecord } from "./wallet.record";

/** Persistence model of a row in `wager_transactions`. Nullable columns are `null` when absent. */
export class WagerTransactionRecord {
  id!: string;
  providerId!: string;
  externalTransactionId!: string;
  idempotencyKey!: string;
  payloadHash!: string;
  correlationId!: string;
  wallet!: WalletRecord;
  playerId!: string;
  roundId!: string;
  gameId!: string;
  kind!: string;
  amount!: string;
  currency!: string;
  referenceExternalTransactionId!: string | null;
  referenceTransactionId!: string | null;
  status!: string;
  failureCode!: string | null;
  observedBalance!: string | null;
  observedCurrency!: string | null;
  observedWalletVersion!: number | null;
  attempts!: number;
  nextAttemptAt!: Date | null;
  createdAt!: Date;
  updatedAt!: Date;
  processedAt!: Date | null;
}

export const WagerTransactionSchema = new EntitySchema<WagerTransactionRecord>({
  class: WagerTransactionRecord,
  tableName: "wager_transactions",
  properties: {
    id: { type: "uuid", primary: true },
    providerId: { type: "string", length: 64 },
    externalTransactionId: { type: "string", length: 128 },
    idempotencyKey: { type: "string", length: 255 },
    payloadHash: { type: "string", length: 64 },
    correlationId: { type: "string", length: 128 },
    wallet: { kind: "m:1", entity: () => WalletRecord },
    playerId: { type: "uuid" },
    roundId: { type: "string", length: 128 },
    gameId: { type: "string", length: 128 },
    kind: { type: "string", length: 16 },
    amount: { type: "decimal", precision: 20, scale: 2 },
    currency: { type: "string", length: 3 },
    referenceExternalTransactionId: { type: "string", length: 128, nullable: true },
    referenceTransactionId: { type: "uuid", nullable: true },
    status: { type: "string", length: 24 },
    failureCode: { type: "string", length: 64, nullable: true },
    observedBalance: { type: "decimal", precision: 20, scale: 2, nullable: true },
    observedCurrency: { type: "string", length: 3, nullable: true },
    observedWalletVersion: { type: "integer", nullable: true },
    attempts: { type: "integer" },
    nextAttemptAt: { type: "datetime", nullable: true },
    createdAt: { type: "datetime" },
    updatedAt: { type: "datetime" },
    processedAt: { type: "datetime", nullable: true },
  },
});

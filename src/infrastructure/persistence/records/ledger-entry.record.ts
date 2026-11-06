import { EntitySchema } from "@mikro-orm/core";
import { WagerTransactionRecord } from "./wager-transaction.record";
import { WalletRecord } from "./wallet.record";

/** Persistence model of a row in the append-only `wallet_ledger_entries`. */
export class LedgerEntryRecord {
  id!: string;
  wallet!: WalletRecord;
  transaction!: WagerTransactionRecord;
  walletVersion!: number;
  direction!: string;
  amount!: string;
  currency!: string;
  balanceBefore!: string;
  balanceAfter!: string;
  createdAt!: Date;
}

export const LedgerEntrySchema = new EntitySchema<LedgerEntryRecord>({
  class: LedgerEntryRecord,
  tableName: "wallet_ledger_entries",
  properties: {
    id: { type: "uuid", primary: true },
    wallet: { kind: "m:1", entity: () => WalletRecord },
    transaction: { kind: "m:1", entity: () => WagerTransactionRecord },
    walletVersion: { type: "integer" },
    direction: { type: "string", length: 6 },
    amount: { type: "decimal", precision: 20, scale: 2 },
    currency: { type: "string", length: 3 },
    balanceBefore: { type: "decimal", precision: 20, scale: 2 },
    balanceAfter: { type: "decimal", precision: 20, scale: 2 },
    createdAt: { type: "datetime" },
  },
});

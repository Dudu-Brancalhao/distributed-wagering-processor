import { InboxMessageSchema } from "./records/inbox-message.record";
import { LedgerEntrySchema } from "./records/ledger-entry.record";
import { OutboxMessageSchema } from "./records/outbox-message.record";
import { WagerTransactionSchema } from "./records/wager-transaction.record";
import { WalletSchema } from "./records/wallet.record";

export const PERSISTENCE_SCHEMAS = [
  WalletSchema,
  WagerTransactionSchema,
  LedgerEntrySchema,
  OutboxMessageSchema,
  InboxMessageSchema,
];

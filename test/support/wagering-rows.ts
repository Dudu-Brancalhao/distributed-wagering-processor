import { sql } from "./sql";

/** Database rows the messaging tests assert on, read independently of the application's ORM. */
export async function transactionRows(providerId: string): Promise<Record<string, unknown>[]> {
  const rows = await sql`
    SELECT id, external_transaction_id, kind, status, failure_code
    FROM wager_transactions WHERE provider_id = ${providerId} ORDER BY created_at`;
  return [...rows];
}

export async function inboxRow(messageId: string) {
  const [row] = await sql`
    SELECT consumer_name, payload_hash, received_at, processed_at FROM inbox_messages WHERE message_id = ${messageId}`;
  return row;
}

export async function ledgerEntryCount(walletId: string): Promise<number> {
  const [{ count }] = await sql`SELECT COUNT(*)::int AS count FROM wallet_ledger_entries WHERE wallet_id = ${walletId}`;
  return count;
}

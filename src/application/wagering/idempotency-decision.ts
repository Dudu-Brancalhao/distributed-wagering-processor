import type { WagerTransaction } from "../../domain/wagering/wager-transaction";

export type IdempotencyDecision = "replay" | "conflict";

/** Same key and same payload hash is a replay; same key with a different payload is a conflict, never a replay. */
export function decideIdempotency(existing: WagerTransaction, payloadHash: string): IdempotencyDecision {
  return existing.matchesPayload(payloadHash) ? "replay" : "conflict";
}

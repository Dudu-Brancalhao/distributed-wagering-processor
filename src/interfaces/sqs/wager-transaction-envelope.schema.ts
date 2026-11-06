import { z } from "zod";
import { idempotencyKeyField, messageIdField } from "../shared/input-formats";
import { wagerTransactionRequestSchema } from "../shared/wager-transaction-request.schema";

export const WAGER_TRANSACTION_REQUESTED = "WagerTransactionRequested";

/** The `WagerTransactionRequested` envelope (challenge section 10); `data` shares the HTTP request rules. */
export const wagerTransactionEnvelopeSchema = z.object({
  messageId: messageIdField,
  type: z.literal(WAGER_TRANSACTION_REQUESTED),
  occurredAt: z.iso.datetime({ offset: true }),
  data: wagerTransactionRequestSchema.safeExtend({ idempotencyKey: idempotencyKeyField }),
});

export type WagerTransactionEnvelope = z.infer<typeof wagerTransactionEnvelopeSchema>;

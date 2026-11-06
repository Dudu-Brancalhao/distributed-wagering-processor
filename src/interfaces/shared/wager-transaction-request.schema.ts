import { z } from "zod";
import { WagerTransactionKind } from "../../domain/wagering/wager-transaction-kind";
import { externalIdField, moneyField, providerIdField, submittableKindField, uuidField } from "./input-formats";

const REFERENCE_REQUIRED = new Set<string>([WagerTransactionKind.Refund, WagerTransactionKind.Rollback]);

/**
 * The business fields of a wager transaction request (HTTP body, SQS `data`). Unknown fields are stripped and an
 * absent or null reference is normalized to undefined.
 */
export const wagerTransactionRequestSchema = z
  .object({
    providerId: providerIdField,
    externalTransactionId: externalIdField,
    playerId: uuidField,
    walletId: uuidField,
    roundId: externalIdField,
    gameId: externalIdField,
    kind: submittableKindField,
    money: moneyField,
    referenceExternalTransactionId: externalIdField.nullish().transform((value) => value ?? undefined),
  })
  .superRefine((request, context) => {
    const hasReference = request.referenceExternalTransactionId !== undefined;
    if (REFERENCE_REQUIRED.has(request.kind) && !hasReference) {
      context.addIssue({
        code: "custom",
        path: ["referenceExternalTransactionId"],
        message: `required for ${request.kind}`,
      });
    }
    if (request.kind === WagerTransactionKind.Bet && hasReference) {
      context.addIssue({ code: "custom", path: ["referenceExternalTransactionId"], message: "not allowed for BET" });
    }
    if (request.kind !== WagerTransactionKind.Loss && request.money.isZero()) {
      context.addIssue({ code: "custom", path: ["money", "amount"], message: `must be positive for ${request.kind}` });
    }
  });

export type WagerTransactionRequest = z.infer<typeof wagerTransactionRequestSchema>;

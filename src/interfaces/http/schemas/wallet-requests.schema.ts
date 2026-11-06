import { z } from "zod";
import { moneyField, uuidField } from "../../shared/input-formats";
import { LedgerCursor } from "../ledger-cursor";

const DEFAULT_LEDGER_PAGE_SIZE = 50;
const MAX_LEDGER_PAGE_SIZE = 200;

export const createWalletBodySchema = z.object({ playerId: uuidField, initialBalance: moneyField });

export const ledgerPageQuerySchema = z.object({
  cursor: z
    .string()
    .optional()
    .transform((cursor, context) => {
      if (cursor === undefined) return undefined;
      const beforeVersion = LedgerCursor.decode(cursor);
      if (beforeVersion === undefined) {
        context.addIssue({ code: "custom", message: "invalid cursor" });
        return z.NEVER;
      }
      return beforeVersion;
    }),
  limit: z.coerce.number().int().min(1).max(MAX_LEDGER_PAGE_SIZE).default(DEFAULT_LEDGER_PAGE_SIZE),
});

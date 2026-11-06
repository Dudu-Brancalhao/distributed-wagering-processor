import { z } from "zod";

const cursorPayload = z.object({ v: z.number().int().min(1) });

/** Opaque page cursor: base64url of `{"v":<last wallet version of the page>}` (spec 3.13). */
export const LedgerCursor = {
  encode(lastWalletVersion: number): string {
    return Buffer.from(JSON.stringify({ v: lastWalletVersion }), "utf8").toString("base64url");
  },

  /** The wallet version to page below, or undefined when the cursor is malformed. */
  decode(cursor: string): number | undefined {
    try {
      const parsed = cursorPayload.safeParse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
      return parsed.success ? parsed.data.v : undefined;
    } catch {
      return undefined;
    }
  },
};

import { createHash } from "node:crypto";
import { canonicalJson, type JsonValue } from "../shared/canonical-json";

/**
 * Lowercase hex SHA-256 of the canonical JSON of a message's `data` object (spec 3.14). Transport fields stay out,
 * so a producer that re-stamps them on a resend still sends a duplicate.
 */
export const InboxPayloadHash = {
  of(data: JsonValue): string {
    return createHash("sha256").update(canonicalJson(data), "utf8").digest("hex");
  },
};

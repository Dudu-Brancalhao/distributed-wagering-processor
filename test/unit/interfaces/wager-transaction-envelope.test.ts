import { describe, expect, test } from "bun:test";
import { wagerTransactionEnvelopeSchema } from "../../../src/interfaces/sqs/wager-transaction-envelope.schema";

const validEnvelope = () => ({
  messageId: "message-1",
  type: "WagerTransactionRequested",
  occurredAt: "2026-11-06T00:00:00.000Z",
  data: {
    providerId: "provider-a",
    externalTransactionId: "transaction-123",
    idempotencyKey: "provider-a:transaction-123",
    playerId: "0192F28F-5DC0-7D58-BDB2-814AD6A0F4A1",
    walletId: "0192f291-27dd-7d3f-8071-5f8685deef37",
    roundId: "round-987",
    gameId: "fortune-chimp",
    kind: "BET",
    money: { amount: "25.00", currency: "BRL" },
  },
});

describe("WagerTransactionRequested envelope (R-44)", () => {
  test("a valid envelope parses into the command fields, UUIDs lowercased and unknown fields stripped", () => {
    const envelope = validEnvelope();
    const parsed = wagerTransactionEnvelopeSchema.parse({ ...envelope, data: { ...envelope.data, extra: "x" } });
    expect(parsed.data.idempotencyKey).toBe("provider-a:transaction-123");
    expect(parsed.data.playerId).toBe("0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1");
    expect(parsed.data.money.toJSON()).toEqual({ amount: "25.00", currency: "BRL" });
    expect("extra" in parsed.data).toBe(false);
  });

  test.each([
    ["an unsupported type", (e: ReturnType<typeof validEnvelope>) => ({ ...e, type: "Other" })],
    ["a missing messageId", ({ messageId: _, ...rest }: ReturnType<typeof validEnvelope>) => rest],
    ["a non ISO-8601 occurredAt", (e: ReturnType<typeof validEnvelope>) => ({ ...e, occurredAt: "yesterday" })],
    [
      "a missing idempotency key",
      (e: ReturnType<typeof validEnvelope>) => ({ ...e, data: { ...e.data, idempotencyKey: undefined } }),
    ],
    [
      "money as a JSON number (E-01)",
      (e: ReturnType<typeof validEnvelope>) => ({ ...e, data: { ...e.data, money: { amount: 25, currency: "BRL" } } }),
    ],
    [
      "the internal OPENING kind",
      (e: ReturnType<typeof validEnvelope>) => ({ ...e, data: { ...e.data, kind: "OPENING" } }),
    ],
    [
      "a REFUND without its reference",
      (e: ReturnType<typeof validEnvelope>) => ({ ...e, data: { ...e.data, kind: "REFUND" } }),
    ],
  ])("rejects %s", (_case, mutate) => {
    expect(wagerTransactionEnvelopeSchema.safeParse(mutate(validEnvelope())).success).toBe(false);
  });
});

import { describe, expect, test } from "bun:test";
import { canonicalJson } from "../../../src/application/shared/canonical-json";
import { decideIdempotency } from "../../../src/application/wagering/idempotency-decision";
import { PayloadHash, type WagerPayloadFields } from "../../../src/application/wagering/payload-hash";
import { Kind, transaction } from "../support/fixtures";

const challengeExample: WagerPayloadFields = {
  providerId: "provider-a",
  externalTransactionId: "transaction-123",
  playerId: "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  walletId: "0192f291-27dd-7d3f-8071-5f8685deef37",
  roundId: "round-987",
  gameId: "fortune-chimp",
  kind: "BET",
  money: { amount: "25.00", currency: "BRL" },
};

describe("canonicalJson", () => {
  test("sorts keys at every level, drops undefined members and adds no whitespace", () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: true, y: null }], c: "x" }, u: undefined })).toBe(
      '{"a":{"c":"x","d":[2,{"y":null,"z":true}]},"b":1}',
    );
  });

  test("escapes strings like JSON.stringify", () => {
    expect(canonicalJson({ 'q"k': 'v"\n' })).toBe('{"q\\"k":"v\\"\\n"}');
  });
});

describe("PayloadHash", () => {
  test("matches the spec 3.11 test vector", () => {
    expect(PayloadHash.of(challengeExample)).toBe("629836932b79106b99523d06a1e7fa80689b0ea1e1c47aa3f0a5a2c87d0c4344");
  });

  test("does not depend on field order or UUID case", () => {
    const reordered: WagerPayloadFields = {
      money: { currency: "BRL", amount: "25.00" },
      kind: "BET",
      gameId: "fortune-chimp",
      roundId: "round-987",
      walletId: challengeExample.walletId.toUpperCase(),
      playerId: challengeExample.playerId.toUpperCase(),
      externalTransactionId: "transaction-123",
      providerId: "provider-a",
    };
    expect(PayloadHash.of(reordered)).toBe(PayloadHash.of(challengeExample));
  });

  test("an absent or null reference hashes the same; transport fields are ignored", () => {
    const withTransport = { ...challengeExample, idempotencyKey: "k", messageId: "m", occurredAt: "now" };
    expect(PayloadHash.of(withTransport)).toBe(PayloadHash.of(challengeExample));
    expect(PayloadHash.of({ ...challengeExample, referenceExternalTransactionId: null })).toBe(
      PayloadHash.of(challengeExample),
    );
  });

  test.each([
    ["providerId", { providerId: "provider-b" }],
    ["externalTransactionId", { externalTransactionId: "transaction-124" }],
    ["playerId", { playerId: "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a2" }],
    ["walletId", { walletId: "0192f291-27dd-7d3f-8071-5f8685deef38" }],
    ["roundId", { roundId: "round-988" }],
    ["gameId", { gameId: "other-game" }],
    ["kind", { kind: "WIN" }],
    ["amount", { money: { amount: "25.01", currency: "BRL" } }],
    ["currency", { money: { amount: "25.00", currency: "USD" } }],
    ["reference", { referenceExternalTransactionId: "bet-1" }],
  ])("changing %s changes the hash", (_field, change) => {
    expect(PayloadHash.of({ ...challengeExample, ...change })).not.toBe(PayloadHash.of(challengeExample));
  });
});

describe("idempotency decision", () => {
  test("same key and same payload is a replay", () => {
    const hash = PayloadHash.of(challengeExample);
    expect(decideIdempotency(transaction(Kind.Bet, "25.00", { payloadHash: hash }), hash)).toBe("replay");
  });

  test("same key with a divergent payload is a conflict, never a replay", () => {
    const original = transaction(Kind.Bet, "25.00", { payloadHash: PayloadHash.of(challengeExample) });
    const divergent = PayloadHash.of({ ...challengeExample, money: { amount: "26.00", currency: "BRL" } });
    expect(decideIdempotency(original, divergent)).toBe("conflict");
  });
});

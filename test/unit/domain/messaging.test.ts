import { describe, expect, test } from "bun:test";
import { WagerTransactionProcessed } from "../../../src/domain/events/wager-transaction-processed";
import { InboxMessage } from "../../../src/domain/messaging/inbox-message";
import { InvalidMessageStateError } from "../../../src/domain/messaging/messaging.errors";
import { OutboxMessage } from "../../../src/domain/messaging/outbox-message";
import { RetrySchedule } from "../../../src/domain/messaging/retry-schedule";
import { Kind, nextId, processor, T0, transaction, walletWith } from "../support/fixtures";

const T1 = new Date(T0.getTime() + 60_000);

describe("RetrySchedule", () => {
  const schedule = RetrySchedule.of({ baseMs: 1000, capMs: 300_000 });

  test("doubles from the base and stops at the cap", () => {
    expect([0, 1, 2, 8, 9, 30].map((attempt) => schedule.nominalDelayMs(attempt))).toEqual([
      1000, 2000, 4000, 256_000, 300_000, 300_000,
    ]);
  });

  test("applies at most plus or minus 20% jitter", () => {
    expect(schedule.delayMs(3, () => 0)).toBe(6400);
    expect(schedule.delayMs(3, () => 0.5)).toBe(8000);
    expect(schedule.delayMs(3, () => 1)).toBe(9600);
  });

  test("rejects invalid configuration and attempts", () => {
    expect(() => RetrySchedule.of({ baseMs: 0, capMs: 10 })).toThrow(RangeError);
    expect(() => RetrySchedule.of({ baseMs: 10, capMs: 5 })).toThrow(RangeError);
    expect(() => schedule.nominalDelayMs(-1)).toThrow(RangeError);
  });
});

describe("InboxMessage", () => {
  test("is received unprocessed, then processed exactly once", () => {
    const inbox = InboxMessage.receive({ messageId: "msg-1", consumerName: "c", payloadHash: "h", receivedAt: T0 });
    expect(inbox.isProcessed()).toBe(false);
    expect(inbox.matchesPayload("h")).toBe(true);
    inbox.markProcessed(T1);
    expect(inbox.processedAt).toEqual(T1);
    expect(() => inbox.markProcessed(T1)).toThrow(InvalidMessageStateError);
  });
});

describe("OutboxMessage", () => {
  function message() {
    const wallet = walletWith("10.00");
    const bet = transaction(Kind.Bet, "1.00");
    processor().process({ transaction: bet, wallet, referenceAlreadyReversed: false, entryId: nextId(), at: T0 });
    return OutboxMessage.enqueue(
      WagerTransactionProcessed.from(bet, { eventId: "evt-9", correlationId: "c", occurredAt: T0 }),
    );
  }

  test("enqueue stores the serialized envelope, due at once", () => {
    const outbox = message();
    expect(outbox.id).toBe("evt-9");
    expect(outbox.eventType).toBe("WagerTransactionProcessed");
    expect(outbox.payload.eventId).toBe("evt-9");
    expect(outbox.attempts).toBe(0);
    expect(outbox.isDue(T0)).toBe(true);
  });

  test("scheduleRetry counts the attempt and backs off", () => {
    const outbox = message();
    const schedule = RetrySchedule.of({ baseMs: 1000, capMs: 300_000, jitterRatio: 0 });
    outbox.scheduleRetry(T0, schedule);
    outbox.scheduleRetry(T0, schedule);
    expect(outbox.attempts).toBe(2);
    expect(outbox.nextAttemptAt).toEqual(new Date(T0.getTime() + 2000));
    expect(outbox.isDue(T0)).toBe(false);
  });

  test("markPublished is final", () => {
    const outbox = message();
    outbox.markPublished(T1);
    expect(outbox.isPending()).toBe(false);
    expect(outbox.isDue(T1)).toBe(false);
    expect(() => outbox.markPublished(T1)).toThrow(InvalidMessageStateError);
  });
});

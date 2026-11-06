import { describe, expect, test } from "bun:test";
import { MeasureOutboxLag } from "../../../src/application/outbox/measure-outbox-lag";
import { PublishOutboxBatch } from "../../../src/application/outbox/publish-outbox-batch";
import type { AppLogger, LogFields } from "../../../src/application/ports/app-logger.port";
import type { EventPublisher, PublishOutcome } from "../../../src/application/ports/event-publisher.port";
import type { OutboxRepository } from "../../../src/application/ports/outbox.repository";
import type { UnitOfWork } from "../../../src/application/ports/unit-of-work.port";
import type { RetryComponent, WageringMetrics } from "../../../src/application/ports/wagering-metrics.port";
import { OutboxMessage } from "../../../src/domain/messaging/outbox-message";
import { RetrySchedule } from "../../../src/domain/messaging/retry-schedule";
import { nextId, T0 } from "../support/fixtures";

const BASE_MS = 1000;
const schedule = RetrySchedule.of({ baseMs: BASE_MS, capMs: 300_000 });
const NOW = new Date(T0.getTime() + 60_000);

const directUnitOfWork: UnitOfWork = { run: (work) => work(), isolated: (work) => work() };

class InMemoryOutbox implements OutboxRepository {
  readonly saved: { message: OutboxMessage; lastError?: string }[] = [];

  constructor(readonly messages: OutboxMessage[]) {}

  add(messages: readonly OutboxMessage[]): void {
    this.messages.push(...messages);
  }

  async claimDue(now: Date, limit: number): Promise<OutboxMessage[]> {
    return this.messages.filter((message) => message.isDue(now)).slice(0, limit);
  }

  saveAttempt(message: OutboxMessage, lastError?: string): void {
    this.saved.push({ message, lastError });
  }

  async oldestPendingOccurredAt(): Promise<Date | undefined> {
    return this.messages.find((message) => message.isPending())?.occurredAt;
  }
}

class RecordingMetrics implements WageringMetrics {
  readonly retries: RetryComponent[] = [];
  lagSeconds?: number;

  transactionRecorded(): void {}
  duplicateDetected(): void {}
  idempotencyConflict(): void {}
  walletLockWaited(): void {}
  lockConflict(): void {}
  processingObserved(): void {}
  reconciliationDivergence(): void {}
  deadLettered(): void {}

  retried(component: RetryComponent): void {
    this.retries.push(component);
  }

  outboxLagObserved(seconds: number): void {
    this.lagSeconds = seconds;
  }
}

class RecordingLogger implements AppLogger {
  readonly lines: { level: string; fields?: LogFields }[] = [];

  debug(_message: string, fields?: LogFields): void {
    this.lines.push({ level: "debug", fields });
  }
  info(_message: string, fields?: LogFields): void {
    this.lines.push({ level: "info", fields });
  }
  warn(_message: string, fields?: LogFields): void {
    this.lines.push({ level: "warn", fields });
  }
  error(_message: string, fields?: LogFields): void {
    this.lines.push({ level: "error", fields });
  }
}

function message(occurredAt = T0): OutboxMessage {
  const id = nextId("event");
  return OutboxMessage.rehydrate({
    id,
    aggregateId: nextId("aggregate"),
    eventType: "WalletBalanceChanged",
    payload: {
      eventId: id,
      eventType: "WalletBalanceChanged",
      aggregateId: "a",
      correlationId: "corr-1",
      occurredAt: occurredAt.toISOString(),
      version: 1,
      data: {},
    },
    occurredAt,
    attempts: 0,
  });
}

function publishing(outcome: PublishOutcome | Error): EventPublisher & { batches: OutboxMessage[][] } {
  const batches: OutboxMessage[][] = [];
  return {
    batches,
    async publish(messages) {
      batches.push([...messages]);
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
  };
}

function setup(messages: OutboxMessage[], publisher: EventPublisher, batchSize = 10) {
  const outbox = new InMemoryOutbox(messages);
  const metrics = new RecordingMetrics();
  const logger = new RecordingLogger();
  const useCase = new PublishOutboxBatch({
    unitOfWork: directUnitOfWork,
    outbox,
    publisher,
    clock: { now: () => NOW },
    retrySchedule: schedule,
    metrics,
    logger,
    batchSize,
  });
  return { useCase, outbox, metrics, logger };
}

const events = (logger: RecordingLogger) => logger.lines.map((line) => line.fields?.event);

describe("PublishOutboxBatch", () => {
  test("marks every accepted message published, counting the attempt", async () => {
    const messages = [message(), message()];
    const { useCase, outbox, metrics, logger } = setup(messages, publishing({ failures: new Map() }));

    expect(await useCase.execute()).toEqual({ published: 2, failed: 0, full: false });
    expect(outbox.saved.map((entry) => entry.lastError)).toEqual([undefined, undefined]);
    expect(messages.map((entry) => [entry.publishedAt, entry.attempts])).toEqual([
      [NOW, 1],
      [NOW, 1],
    ]);
    expect(metrics.retries).toEqual([]);
    expect(events(logger)).toEqual(["outbox.published"]);
  });

  test("schedules a backoff retry for each rejected entry and publishes the rest", async () => {
    const [accepted, rejected] = [message(), message()] as [OutboxMessage, OutboxMessage];
    const failures = new Map([[rejected.id, "InternalError: throttled"]]);
    const { useCase, outbox, metrics, logger } = setup([accepted, rejected], publishing({ failures }));

    expect(await useCase.execute()).toEqual({ published: 1, failed: 1, full: false });
    expect(accepted.publishedAt).toEqual(NOW);
    expect(rejected.isPending()).toBe(true);
    expect(rejected.attempts).toBe(1);
    const delay = (rejected.nextAttemptAt?.getTime() ?? 0) - NOW.getTime();
    expect(delay).toBeGreaterThanOrEqual(BASE_MS * 0.8);
    expect(delay).toBeLessThanOrEqual(BASE_MS * 1.2);
    expect(outbox.saved.find((entry) => entry.message === rejected)?.lastError).toBe("InternalError: throttled");
    expect(metrics.retries).toEqual(["outbox"]);
    expect(events(logger)).toEqual(["outbox.published", "outbox.publish_failed"]);
  });

  test("a call that fails as a whole schedules a retry for the whole batch", async () => {
    const messages = [message(), message()];
    const { useCase, outbox, metrics } = setup(messages, publishing(new TypeError("socket hang up")));

    expect(await useCase.execute()).toEqual({ published: 0, failed: 2, full: false });
    expect(messages.every((entry) => entry.isPending() && entry.attempts === 1)).toBe(true);
    expect(outbox.saved.map((entry) => entry.lastError)).toEqual([
      "TypeError: socket hang up",
      "TypeError: socket hang up",
    ]);
    expect(metrics.retries).toEqual(["outbox", "outbox"]);
  });

  test("claims at most one batch and reports when it was full", async () => {
    const publisher = publishing({ failures: new Map() });
    const { useCase } = setup([message(), message(), message()], publisher, 2);

    expect(await useCase.execute()).toEqual({ published: 2, failed: 0, full: true });
    expect(publisher.batches.map((batch) => batch.length)).toEqual([2]);
  });

  test("does not call the publisher when nothing is due", async () => {
    const waiting = message();
    waiting.scheduleRetry(NOW, schedule);
    const publisher = publishing({ failures: new Map() });
    const { useCase, logger } = setup([waiting], publisher);

    expect(await useCase.execute()).toEqual({ published: 0, failed: 0, full: false });
    expect(publisher.batches).toEqual([]);
    expect(logger.lines).toEqual([]);
  });
});

describe("MeasureOutboxLag", () => {
  const measure = (messages: OutboxMessage[]) => {
    const metrics = new RecordingMetrics();
    const useCase = new MeasureOutboxLag(directUnitOfWork, new InMemoryOutbox(messages), { now: () => NOW }, metrics);
    return { useCase, metrics };
  };

  test("reports the age of the oldest unpublished message in seconds", async () => {
    const { useCase, metrics } = measure([message(T0)]);
    expect(await useCase.execute()).toBe(60);
    expect(metrics.lagSeconds).toBe(60);
  });

  test("reports 0 when nothing is waiting", async () => {
    const published = message(T0);
    published.markPublished(NOW);
    const { useCase, metrics } = measure([published]);
    expect(await useCase.execute()).toBe(0);
    expect(metrics.lagSeconds).toBe(0);
  });
});

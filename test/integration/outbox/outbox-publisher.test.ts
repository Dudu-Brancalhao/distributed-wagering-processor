import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Writable } from "node:stream";
import { CreateQueueCommand } from "@aws-sdk/client-sqs";
import type { INestApplication } from "@nestjs/common";
import type { Registry } from "prom-client";
import type { OutboxRepository } from "../../../src/application/ports/outbox.repository";
import type { UnitOfWork } from "../../../src/application/ports/unit-of-work.port";
import { createApp } from "../../../src/bootstrap";
import type { IntegrationEventEnvelope } from "../../../src/domain/events/integration-event";
import { OutboxMessage } from "../../../src/domain/messaging/outbox-message";
import { METRICS_REGISTRY } from "../../../src/infrastructure/observability/observability.tokens";
import { OUTBOX_REPOSITORY, UNIT_OF_WORK } from "../../../src/infrastructure/persistence/persistence.tokens";
import { provisionQueues, receiveEvents, type TestQueues, uniqueQueueNames } from "../../support/event-queue";
import { eventually } from "../../support/eventually";
import { sql } from "../../support/sql";
import { testConfig } from "../../support/test-config";
import { newId } from "../../support/wagering-requests";

/**
 * S-06: the outbox publisher against the real PostgreSQL and SQS emulator. Publishers run as in-process
 * applications with the `outbox` role only, each with its own database pool, so they really race for the rows.
 */
const PUBLISH_TIMEOUT_MS = 20_000;
const ONE_HOUR_MS = 3_600_000;
/** Booting an application opens its database pool; leave hooks room beyond Bun's 5 s default. */
const STARTUP_TIMEOUT_MS = 30_000;
const publisherSettings = {
  APP_ROLES: "outbox",
  OUTBOX_BATCH_SIZE: "5",
  OUTBOX_POLL_INTERVAL_MS: "100",
  OUTBOX_RETRY_BASE_MS: "50",
  OUTBOX_RETRY_MAX_MS: "200",
};
const queueNames = uniqueQueueNames();
let testQueues: TestQueues;

const discard = () => new Writable({ write: (_chunk, _encoding, done) => done() });

async function startPublisher(overrides: Record<string, string> = {}): Promise<INestApplication> {
  const app = await createApp(testConfig({ ...publisherSettings, ...queueNames, ...overrides }), discard());
  await app.init();
  return app;
}

function pendingMessage(occurredAt = new Date()): OutboxMessage {
  const id = newId();
  const aggregateId = newId();
  const payload: IntegrationEventEnvelope<unknown> = {
    eventId: id,
    eventType: "WalletBalanceChanged",
    aggregateId,
    correlationId: `corr-${newId()}`,
    occurredAt: occurredAt.toISOString(),
    version: 1,
    data: { walletId: aggregateId, walletVersion: 2 },
  };
  return OutboxMessage.rehydrate({ id, aggregateId, eventType: payload.eventType, payload, occurredAt, attempts: 0 });
}

/** Commits the messages in one SQL transaction, through the application's own outbox repository. */
async function enqueue(app: INestApplication, messages: readonly OutboxMessage[]): Promise<void> {
  const unitOfWork = app.get<UnitOfWork>(UNIT_OF_WORK);
  const outbox = app.get<OutboxRepository>(OUTBOX_REPOSITORY);
  await unitOfWork.isolated(() => unitOfWork.run(async () => outbox.add(messages)));
}

interface OutboxRow {
  readonly id: string;
  readonly attempts: number;
  readonly published: boolean;
  readonly retry_scheduled: boolean;
  readonly last_error: string | null;
}

async function outboxRows(ids: readonly string[]): Promise<OutboxRow[]> {
  return sql`
    SELECT id, attempts, published_at IS NOT NULL AS published, next_attempt_at > occurred_at AS retry_scheduled,
           last_error
    FROM outbox_messages WHERE id IN ${sql(ids)} ORDER BY id`;
}

async function outboxRetries(app: INestApplication): Promise<number> {
  const metric = await app.get<Registry>(METRICS_REGISTRY).getSingleMetric("wagering_retries_total")?.get();
  return metric?.values.find((value) => value.labels.component === "outbox")?.value ?? 0;
}

beforeAll(async () => {
  testQueues = await provisionQueues(queueNames);
}, STARTUP_TIMEOUT_MS);

describe("two concurrent publishers", () => {
  const publishers: INestApplication[] = [];

  beforeAll(async () => {
    publishers.push(await startPublisher(), await startPublisher());
  }, STARTUP_TIMEOUT_MS);

  afterAll(async () => {
    await Promise.all(publishers.map((publisher) => publisher.close()));
  }, STARTUP_TIMEOUT_MS);

  test(
    "publish every row exactly once",
    async () => {
      const messages = Array.from({ length: 60 }, () => pendingMessage());
      const ids = messages.map((message) => message.id);
      await enqueue(publishers[0] as INestApplication, messages);

      const rows = await eventually(
        async () => {
          const current = await outboxRows(ids);
          expect(current.every((row) => row.published)).toBe(true);
          return current;
        },
        { timeoutMs: PUBLISH_TIMEOUT_MS },
      );
      expect(rows).toHaveLength(ids.length);
      expect(rows.every((row) => row.attempts === 1 && row.last_error === null)).toBe(true);

      const expected = new Set(ids);
      const received = await receiveEvents(
        testQueues.sqs,
        testQueues.queues.eventsQueueUrl,
        (events) => ids.every((id) => events.some((event) => event.envelope.eventId === id)),
        { timeoutMs: PUBLISH_TIMEOUT_MS },
      );
      const receivedIds = received.map((event) => event.envelope.eventId).filter((id) => expected.has(id));
      expect(receivedIds.toSorted()).toEqual(ids.toSorted());
    },
    PUBLISH_TIMEOUT_MS * 2,
  );

  test("send the envelope as the body, grouped by aggregate and deduplicated by event id", async () => {
    const message = pendingMessage();
    await enqueue(publishers[0] as INestApplication, [message]);
    const received = await receiveEvents(
      testQueues.sqs,
      testQueues.queues.eventsQueueUrl,
      (events) => events.some((event) => event.envelope.eventId === message.id),
      { timeoutMs: PUBLISH_TIMEOUT_MS },
    );
    expect(received.find((event) => event.envelope.eventId === message.id)).toEqual({
      envelope: message.payload,
      groupId: message.aggregateId,
      deduplicationId: message.id,
      attributes: { eventType: "WalletBalanceChanged", version: "1", correlationId: message.payload.correlationId },
    });
  });
});

describe("a failed send", () => {
  const missingQueueName = `wagering-events-missing-${newId().slice(-12)}.fifo`;
  let publisher: INestApplication;

  beforeAll(async () => {
    publisher = await startPublisher({ SQS_EVENTS_QUEUE_NAME: missingQueueName });
  }, STARTUP_TIMEOUT_MS);

  afterAll(async () => {
    await publisher.close();
  }, STARTUP_TIMEOUT_MS);

  test(
    "schedules a retry with the error, and the message is published once the queue is reachable",
    async () => {
      const message = pendingMessage();
      await enqueue(publisher, [message]);

      const [failed] = await eventually(
        async () => {
          const rows = await outboxRows([message.id]);
          expect(rows[0]?.attempts).toBeGreaterThanOrEqual(1);
          return rows;
        },
        { timeoutMs: PUBLISH_TIMEOUT_MS },
      );
      expect(failed).toMatchObject({ published: false, retry_scheduled: true });
      expect(failed?.last_error).toContain("QueueDoesNotExist");
      expect(failed?.last_error).not.toContain(message.payload.correlationId);
      expect(await outboxRetries(publisher)).toBeGreaterThan(0);

      const created = await testQueues.sqs.send(
        new CreateQueueCommand({
          QueueName: missingQueueName,
          Attributes: { FifoQueue: "true", ContentBasedDeduplication: "false" },
        }),
      );
      const [published] = await eventually(
        async () => {
          const rows = await outboxRows([message.id]);
          expect(rows[0]?.published).toBe(true);
          return rows;
        },
        { timeoutMs: PUBLISH_TIMEOUT_MS },
      );
      expect(published?.attempts).toBeGreaterThan(failed?.attempts ?? 0);
      const received = await receiveEvents(
        testQueues.sqs,
        created.QueueUrl ?? "",
        (events) => events.some((event) => event.envelope.eventId === message.id),
        { timeoutMs: PUBLISH_TIMEOUT_MS },
      );
      expect(received.some((event) => event.envelope.eventId === message.id)).toBe(true);
    },
    PUBLISH_TIMEOUT_MS * 3,
  );
});

describe("outbox lag", () => {
  test(
    "is sampled each tick as the age of the oldest unpublished row",
    async () => {
      const publisher = await startPublisher({
        SQS_EVENTS_QUEUE_NAME: `wagering-events-absent-${newId().slice(-12)}.fifo`,
      });
      try {
        await enqueue(publisher, [pendingMessage(new Date(Date.now() - ONE_HOUR_MS))]);
        await eventually(async () => {
          const metric = await publisher
            .get<Registry>(METRICS_REGISTRY)
            .getSingleMetric("wagering_outbox_lag_seconds")
            ?.get();
          expect(metric?.values[0]?.value).toBeGreaterThanOrEqual(ONE_HOUR_MS / 1000);
        });
      } finally {
        await publisher.close();
      }
    },
    STARTUP_TIMEOUT_MS,
  );
});

import { Module } from "@nestjs/common";
import { MeasureOutboxLag } from "../../application/outbox/measure-outbox-lag";
import { PublishOutboxBatch } from "../../application/outbox/publish-outbox-batch";
import type { AppLogger } from "../../application/ports/app-logger.port";
import type { Clock } from "../../application/ports/clock.port";
import type { EventPublisher } from "../../application/ports/event-publisher.port";
import type { IdGenerator } from "../../application/ports/id-generator.port";
import type { OutboxRepository } from "../../application/ports/outbox.repository";
import type { UnitOfWork } from "../../application/ports/unit-of-work.port";
import type { WageringMetrics } from "../../application/ports/wagering-metrics.port";
import { RetrySchedule } from "../../domain/messaging/retry-schedule";
import { APP_CONFIG } from "../../infrastructure/config/app-config.token";
import type { AppConfig } from "../../infrastructure/config/config.schema";
import { APP_LOGGER, WAGERING_METRICS } from "../../infrastructure/observability/observability.tokens";
import { OUTBOX_REPOSITORY, UNIT_OF_WORK } from "../../infrastructure/persistence/persistence.tokens";
import { CLOCK, ID_GENERATOR } from "../../infrastructure/runtime/runtime.tokens";
import { EVENT_PUBLISHER } from "../../infrastructure/sqs/event-publisher.token";
import { createSqsClient } from "../../infrastructure/sqs/sqs-client.factory";
import { SqsEventPublisher } from "../../infrastructure/sqs/sqs-event-publisher";
import { OutboxPublisherWorker } from "./outbox-publisher.worker";

/** Role `outbox`: the transactional outbox publisher (spec 3.15). */
@Module({
  providers: [
    {
      provide: EVENT_PUBLISHER,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => new SqsEventPublisher(createSqsClient(config), config.SQS_EVENTS_QUEUE_NAME),
    },
    {
      provide: PublishOutboxBatch,
      inject: [APP_CONFIG, UNIT_OF_WORK, OUTBOX_REPOSITORY, EVENT_PUBLISHER, CLOCK, WAGERING_METRICS, APP_LOGGER],
      useFactory: (
        config: AppConfig,
        unitOfWork: UnitOfWork,
        outbox: OutboxRepository,
        publisher: EventPublisher,
        clock: Clock,
        metrics: WageringMetrics,
        logger: AppLogger,
      ) =>
        new PublishOutboxBatch({
          unitOfWork,
          outbox,
          publisher,
          clock,
          retrySchedule: RetrySchedule.of({ baseMs: config.OUTBOX_RETRY_BASE_MS, capMs: config.OUTBOX_RETRY_MAX_MS }),
          metrics,
          logger,
          batchSize: config.OUTBOX_BATCH_SIZE,
        }),
    },
    {
      provide: MeasureOutboxLag,
      inject: [UNIT_OF_WORK, OUTBOX_REPOSITORY, CLOCK, WAGERING_METRICS],
      useFactory: (unitOfWork: UnitOfWork, outbox: OutboxRepository, clock: Clock, metrics: WageringMetrics) =>
        new MeasureOutboxLag(unitOfWork, outbox, clock, metrics),
    },
    {
      provide: OutboxPublisherWorker,
      inject: [APP_CONFIG, PublishOutboxBatch, MeasureOutboxLag, ID_GENERATOR, APP_LOGGER],
      useFactory: (
        config: AppConfig,
        publishBatch: PublishOutboxBatch,
        measureLag: MeasureOutboxLag,
        ids: IdGenerator,
        logger: AppLogger,
      ) =>
        new OutboxPublisherWorker({
          publishBatch,
          measureLag,
          ids,
          logger,
          pollIntervalMs: config.OUTBOX_POLL_INTERVAL_MS,
        }),
    },
  ],
})
export class OutboxPublisherModule {}

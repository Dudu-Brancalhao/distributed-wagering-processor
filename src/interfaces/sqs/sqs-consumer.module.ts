import { Module } from "@nestjs/common";
import { ProcessWagerTransactionMessage } from "../../application/messaging/process-wager-transaction-message";
import type { AppLogger } from "../../application/ports/app-logger.port";
import type { Clock } from "../../application/ports/clock.port";
import type { InboxRepository } from "../../application/ports/inbox.repository";
import type { UnitOfWork } from "../../application/ports/unit-of-work.port";
import type { WageringMetrics } from "../../application/ports/wagering-metrics.port";
import { UniqueRaceRetry } from "../../application/shared/unique-race-retry";
import { SubmissionTelemetry } from "../../application/wagering/submission-telemetry";
import { SubmitWagerTransaction } from "../../application/wagering/submit-wager-transaction";
import { RetrySchedule } from "../../domain/messaging/retry-schedule";
import { APP_CONFIG } from "../../infrastructure/config/app-config.token";
import type { AppConfig } from "../../infrastructure/config/config.schema";
import { APP_LOGGER, WAGERING_METRICS } from "../../infrastructure/observability/observability.tokens";
import { INBOX_REPOSITORY, UNIT_OF_WORK } from "../../infrastructure/persistence/persistence.tokens";
import { CLOCK } from "../../infrastructure/runtime/runtime.tokens";
import { SqsQueueGateway } from "../../infrastructure/sqs/sqs-queue-gateway";
import { WagerTransactionConsumer } from "./wager-transaction-consumer";
import { WagerTransactionMessageHandler } from "./wager-transaction-message-handler";

/** The inbox key: every instance of this service shares it, so a message is handled once across all of them. */
export const WAGER_TRANSACTION_CONSUMER_NAME = "wager-transaction-consumer";

const MS_PER_SECOND = 1000;

/** Backoff in whole seconds from the `SQS_RETRY_*` settings, for transient message failures and failing polls. */
const sqsRetrySchedule = (config: AppConfig) =>
  RetrySchedule.of({ baseMs: config.SQS_RETRY_BASE_S * MS_PER_SECOND, capMs: config.SQS_RETRY_MAX_S * MS_PER_SECOND });

/** Role `consumer`: consumes `WagerTransactionRequested` messages through the same use case as the HTTP API. */
@Module({
  providers: [
    {
      provide: ProcessWagerTransactionMessage,
      inject: [
        UNIT_OF_WORK,
        UniqueRaceRetry,
        INBOX_REPOSITORY,
        SubmitWagerTransaction,
        CLOCK,
        SubmissionTelemetry,
        WAGERING_METRICS,
        APP_LOGGER,
      ],
      useFactory: (
        unitOfWork: UnitOfWork,
        raceRetry: UniqueRaceRetry,
        inbox: InboxRepository,
        submitWagerTransaction: SubmitWagerTransaction,
        clock: Clock,
        telemetry: SubmissionTelemetry,
        metrics: WageringMetrics,
        logger: AppLogger,
      ) =>
        new ProcessWagerTransactionMessage({
          consumerName: WAGER_TRANSACTION_CONSUMER_NAME,
          unitOfWork,
          raceRetry,
          inbox,
          submitWagerTransaction,
          clock,
          telemetry,
          metrics,
          logger,
        }),
    },
    {
      provide: WagerTransactionMessageHandler,
      inject: [ProcessWagerTransactionMessage, SqsQueueGateway, WAGERING_METRICS, APP_LOGGER, APP_CONFIG],
      useFactory: (
        processMessage: ProcessWagerTransactionMessage,
        gateway: SqsQueueGateway,
        metrics: WageringMetrics,
        logger: AppLogger,
        config: AppConfig,
      ) =>
        new WagerTransactionMessageHandler({
          processMessage,
          gateway,
          retrySchedule: sqsRetrySchedule(config),
          metrics,
          logger,
        }),
    },
    {
      provide: WagerTransactionConsumer,
      inject: [SqsQueueGateway, WagerTransactionMessageHandler, APP_LOGGER, APP_CONFIG],
      useFactory: (
        gateway: SqsQueueGateway,
        handler: WagerTransactionMessageHandler,
        logger: AppLogger,
        config: AppConfig,
      ) =>
        new WagerTransactionConsumer({
          gateway,
          handle: (message) => handler.handle(message),
          logger,
          concurrency: config.SQS_HANDLER_CONCURRENCY,
          visibilityTimeoutS: config.SQS_VISIBILITY_TIMEOUT_S,
          shutdownGraceMs: config.SHUTDOWN_GRACE_MS,
          receiveRetrySchedule: sqsRetrySchedule(config),
        }),
    },
  ],
})
export class SqsConsumerModule {}

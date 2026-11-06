import type { SQSClient } from "@aws-sdk/client-sqs";
import { Global, Module } from "@nestjs/common";
import { APP_CONFIG } from "../config/app-config.token";
import type { AppConfig } from "../config/config.schema";
import { SQS_CLIENT } from "./sqs.tokens";
import { createSqsClient } from "./sqs-client.factory";
import { SqsHealthIndicator } from "./sqs-health-indicator";
import { SqsQueueGateway } from "./sqs-queue-gateway";
import { SqsQueueUrls } from "./sqs-queue-urls";

const READINESS_TIMEOUT_MS = 1000;

/** The SQS client and the adapters built on it. Every instance needs it for readiness, whatever its roles. */
@Global()
@Module({
  providers: [
    { provide: SQS_CLIENT, inject: [APP_CONFIG], useFactory: (config: AppConfig) => createSqsClient(config) },
    { provide: SqsQueueUrls, inject: [SQS_CLIENT], useFactory: (sqs: SQSClient) => new SqsQueueUrls(sqs) },
    {
      provide: SqsQueueGateway,
      inject: [SQS_CLIENT, SqsQueueUrls, APP_CONFIG],
      useFactory: (sqs: SQSClient, queues: SqsQueueUrls, config: AppConfig) => new SqsQueueGateway(sqs, queues, config),
    },
    {
      provide: SqsHealthIndicator,
      inject: [SQS_CLIENT, SqsQueueUrls, APP_CONFIG],
      useFactory: (sqs: SQSClient, queues: SqsQueueUrls, config: AppConfig) =>
        new SqsHealthIndicator(sqs, queues, config.SQS_WAGER_QUEUE_NAME, READINESS_TIMEOUT_MS),
    },
  ],
  exports: [SQS_CLIENT, SqsQueueUrls, SqsQueueGateway, SqsHealthIndicator],
})
export class SqsModule {}

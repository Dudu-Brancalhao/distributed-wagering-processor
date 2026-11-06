import { Module } from "@nestjs/common";
import type { AppLogger } from "../../application/ports/app-logger.port";
import { RetryPendingReferences } from "../../application/wagering/retry-pending-references";
import { APP_CONFIG } from "../../infrastructure/config/app-config.token";
import type { AppConfig } from "../../infrastructure/config/config.schema";
import { APP_LOGGER } from "../../infrastructure/observability/observability.tokens";
import { PendingReferenceWorker } from "./pending-reference.worker";

/** Role `pending-reference`: the scheduled retrier of PENDING_REFERENCE transactions. */
@Module({
  providers: [
    {
      provide: PendingReferenceWorker,
      inject: [RetryPendingReferences, APP_LOGGER, APP_CONFIG],
      useFactory: (retry: RetryPendingReferences, logger: AppLogger, config: AppConfig) =>
        new PendingReferenceWorker(retry, logger, config.PENDING_REFERENCE_POLL_INTERVAL_MS),
    },
  ],
})
export class PendingReferenceWorkerModule {}

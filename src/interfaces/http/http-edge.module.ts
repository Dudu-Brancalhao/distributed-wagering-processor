import { type MiddlewareConsumer, Module, type NestModule } from "@nestjs/common";
import { APP_FILTER, APP_PIPE } from "@nestjs/core";
import type { AppLogger } from "../../application/ports/app-logger.port";
import { APP_LOGGER } from "../../infrastructure/observability/observability.tokens";
import { HealthController } from "./health.controller";
import { HttpErrorFilter } from "./http-error.filter";
import { MetricsController } from "./metrics.controller";
import { RequestContextMiddleware } from "./request-context.middleware";
import { ShutdownState } from "./shutdown-state";
import { createValidationPipe } from "./validation.pipe";

/**
 * Served by every instance whatever its roles: health checks, metrics, request ids, and the error and validation
 * conventions every endpoint shares.
 */
@Module({
  controllers: [HealthController, MetricsController],
  providers: [
    { provide: APP_FILTER, useClass: HttpErrorFilter },
    { provide: APP_PIPE, useFactory: createValidationPipe },
    { provide: ShutdownState, inject: [APP_LOGGER], useFactory: (logger: AppLogger) => new ShutdownState(logger) },
  ],
})
export class HttpEdgeModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes("*path");
  }
}

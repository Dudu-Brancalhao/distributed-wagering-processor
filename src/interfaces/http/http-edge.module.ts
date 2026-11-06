import { type MiddlewareConsumer, Module, type NestModule } from "@nestjs/common";
import { HealthController } from "./health.controller";
import { MetricsController } from "./metrics.controller";
import { RequestContextMiddleware } from "./request-context.middleware";

/** Endpoints served by every instance whatever its roles: health checks and metrics. */
@Module({ controllers: [HealthController, MetricsController] })
export class HttpEdgeModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes("*path");
  }
}

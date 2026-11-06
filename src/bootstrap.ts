import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type pino from "pino";
import { AppModule } from "./app.module";
import type { AppConfig } from "./infrastructure/config/config.schema";
import { createMetricsRegistry } from "./infrastructure/observability/metrics-registry";
import { NestLoggerAdapter } from "./infrastructure/observability/nest-logger.adapter";
import { createPino } from "./infrastructure/observability/pino-logger";

/** Builds the Nest application for the configured roles without listening. */
export async function createApp(config: AppConfig, destination?: pino.DestinationStream): Promise<INestApplication> {
  const logger = createPino({
    level: config.LOG_LEVEL,
    instanceId: config.INSTANCE_ID,
    roles: config.APP_ROLES,
    destination,
  });
  const registry = createMetricsRegistry(config.INSTANCE_ID);
  const app = await NestFactory.create(AppModule.forRoot({ config, logger, registry }), {
    logger: new NestLoggerAdapter(logger),
  });
  app.enableShutdownHooks();
  return app;
}

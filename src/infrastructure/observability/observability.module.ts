import { type DynamicModule, Global, Module } from "@nestjs/common";
import type { Logger } from "pino";
import type { Registry } from "prom-client";
import { APP_LOGGER, METRICS_REGISTRY } from "./observability.tokens";
import { PinoAppLogger } from "./pino-logger";

@Global()
@Module({})
export class ObservabilityModule {
  static forRoot(logger: Logger, registry: Registry): DynamicModule {
    return {
      module: ObservabilityModule,
      providers: [
        { provide: APP_LOGGER, useValue: new PinoAppLogger(logger) },
        { provide: METRICS_REGISTRY, useValue: registry },
      ],
      exports: [APP_LOGGER, METRICS_REGISTRY],
    };
  }
}

import { type DynamicModule, Global, Module } from "@nestjs/common";
import type { Logger } from "pino";
import type { Registry } from "prom-client";
import { APP_LOGGER, METRICS_REGISTRY, WAGERING_METRICS } from "./observability.tokens";
import { PinoAppLogger } from "./pino-logger";
import { PrometheusWageringMetrics } from "./prometheus-wagering-metrics";

export interface ObservabilityOptions {
  readonly logger: Logger;
  readonly registry: Registry;
  readonly lockContentionThresholdMs: number;
}

@Global()
@Module({})
export class ObservabilityModule {
  static forRoot({ logger, registry, lockContentionThresholdMs }: ObservabilityOptions): DynamicModule {
    return {
      module: ObservabilityModule,
      providers: [
        { provide: APP_LOGGER, useValue: new PinoAppLogger(logger) },
        { provide: METRICS_REGISTRY, useValue: registry },
        { provide: WAGERING_METRICS, useValue: new PrometheusWageringMetrics(registry, lockContentionThresholdMs) },
      ],
      exports: [APP_LOGGER, METRICS_REGISTRY, WAGERING_METRICS],
    };
  }
}

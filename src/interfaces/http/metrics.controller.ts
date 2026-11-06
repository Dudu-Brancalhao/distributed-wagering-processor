import { Controller, Get, Header, Inject } from "@nestjs/common";
import type { Registry } from "prom-client";
import { METRICS_REGISTRY } from "../../infrastructure/observability/observability.tokens";

@Controller("metrics")
export class MetricsController {
  constructor(@Inject(METRICS_REGISTRY) private readonly registry: Registry) {}

  @Get()
  @Header("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
  metrics(): Promise<string> {
    return this.registry.metrics();
  }
}

import { type DynamicModule, Module } from "@nestjs/common";
import type { Logger } from "pino";
import type { Registry } from "prom-client";
import { APP_CONFIG } from "./infrastructure/config/app-config.token";
import type { AppConfig } from "./infrastructure/config/config.schema";
import { ObservabilityModule } from "./infrastructure/observability/observability.module";
import { HttpEdgeModule } from "./interfaces/http/http-edge.module";
import { modulesForRoles } from "./roles";

export interface AppModuleOptions {
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly registry: Registry;
}

@Module({})
export class AppModule {
  static forRoot({ config, logger, registry }: AppModuleOptions): DynamicModule {
    return {
      module: AppModule,
      global: true,
      imports: [ObservabilityModule.forRoot(logger, registry), HttpEdgeModule, ...modulesForRoles(config.APP_ROLES)],
      providers: [{ provide: APP_CONFIG, useValue: config }],
      exports: [APP_CONFIG],
    };
  }
}

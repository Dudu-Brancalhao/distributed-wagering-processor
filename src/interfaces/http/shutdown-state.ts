import type { OnApplicationShutdown, OnModuleDestroy } from "@nestjs/common";
import type { AppLogger } from "../../application/ports/app-logger.port";

/**
 * Whether the process is shutting down (spec 3.17). It flips in the first shutdown hook (`onModuleDestroy`), so
 * readiness reports 503 while the consumer and the workers drain in the hooks that follow.
 */
export class ShutdownState implements OnModuleDestroy, OnApplicationShutdown {
  private shuttingDown = false;

  constructor(private readonly logger: AppLogger) {}

  isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  onModuleDestroy(): void {
    this.shuttingDown = true;
    this.logger.info("shutdown started", { event: "shutdown.started" });
  }

  onApplicationShutdown(signal?: string): void {
    this.logger.info("shutdown completed", { event: "shutdown.completed", signal });
  }
}

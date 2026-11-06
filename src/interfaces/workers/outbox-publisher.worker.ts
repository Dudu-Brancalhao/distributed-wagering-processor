import type { BeforeApplicationShutdown, OnApplicationBootstrap } from "@nestjs/common";
import type { MeasureOutboxLag } from "../../application/outbox/measure-outbox-lag";
import type { PublishOutboxBatch } from "../../application/outbox/publish-outbox-batch";
import type { AppLogger } from "../../application/ports/app-logger.port";
import type { IdGenerator } from "../../application/ports/id-generator.port";
import { LogContext } from "../../infrastructure/observability/log-context";
import { PollingLoop } from "./polling-loop";

export interface OutboxPublisherWorkerDependencies {
  readonly publishBatch: PublishOutboxBatch;
  readonly measureLag: MeasureOutboxLag;
  readonly ids: IdGenerator;
  readonly logger: AppLogger;
  readonly pollIntervalMs: number;
}

/**
 * Role `outbox`: publishes due outbox messages in a loop, at once while batches come back full, otherwise every
 * poll interval, and samples the outbox lag after each tick. On shutdown it finishes the current tick and stops
 * before the database pool closes (spec 3.17).
 */
export class OutboxPublisherWorker implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly loop: PollingLoop;

  constructor(private readonly deps: OutboxPublisherWorkerDependencies) {
    this.loop = new PollingLoop(() => this.tick(), deps.pollIntervalMs);
  }

  onApplicationBootstrap(): void {
    this.loop.start();
  }

  beforeApplicationShutdown(): Promise<void> {
    return this.loop.stop();
  }

  private tick(): Promise<boolean> {
    return LogContext.run({ correlationId: this.deps.ids.next() }, async () => {
      const full = await this.publishBatch();
      await this.measureLag();
      return full;
    });
  }

  private async publishBatch(): Promise<boolean> {
    try {
      return (await this.deps.publishBatch.execute()).full;
    } catch (error) {
      this.logFailure("outbox publisher tick failed", "outbox.tick_failed", error);
      return false;
    }
  }

  private async measureLag(): Promise<void> {
    try {
      await this.deps.measureLag.execute();
    } catch (error) {
      this.logFailure("outbox lag sampling failed", "outbox.lag_sampling_failed", error);
    }
  }

  private logFailure(message: string, event: string, error: unknown): void {
    this.deps.logger.warn(message, { event, error: error instanceof Error ? error.name : String(error) });
  }
}

import type { BeforeApplicationShutdown, OnApplicationBootstrap } from "@nestjs/common";
import type { AppLogger } from "../../application/ports/app-logger.port";
import type { WageringMetrics } from "../../application/ports/wagering-metrics.port";
import type { SqsQueueGateway } from "../../infrastructure/sqs/sqs-queue-gateway";
import { PollingLoop } from "../workers/polling-loop";

export interface DeadLetterDepthSamplerDependencies {
  readonly gateway: Pick<SqsQueueGateway, "deadLetterDepth">;
  /** The `queue` label of the sampled depth. */
  readonly queueName: string;
  readonly metrics: WageringMetrics;
  readonly logger: AppLogger;
  readonly intervalMs: number;
}

/**
 * Role `consumer`: samples the dead-letter queue size every interval (spec 3.18). The counter of explicit moves misses
 * messages the redrive policy moves after too many receives; the sampled depth counts every waiting message.
 */
export class DeadLetterDepthSampler implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly loop: PollingLoop;

  constructor(private readonly deps: DeadLetterDepthSamplerDependencies) {
    this.loop = new PollingLoop(() => this.sample(), deps.intervalMs);
  }

  onApplicationBootstrap(): void {
    this.loop.start();
  }

  beforeApplicationShutdown(): Promise<void> {
    return this.loop.stop();
  }

  /** Never reports more work: one sample per interval. A failed sample keeps the last value and is logged. */
  private async sample(): Promise<boolean> {
    try {
      this.deps.metrics.deadLetterDepthObserved(this.deps.queueName, await this.deps.gateway.deadLetterDepth());
    } catch (error) {
      this.deps.logger.warn("dead-letter queue depth sampling failed", {
        event: "sqs.dlq_depth_sampling_failed",
        error: error instanceof Error ? error.name : "UnknownError",
      });
    }
    return false;
  }
}

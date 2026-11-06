import type { BeforeApplicationShutdown, OnApplicationBootstrap } from "@nestjs/common";
import type { AppLogger } from "../../application/ports/app-logger.port";
import type { RetryPendingReferences } from "../../application/wagering/retry-pending-references";

/**
 * Role `pending-reference` (spec 3.16): runs a retrier tick every poll interval until shutdown, when it finishes the
 * current tick and stops (spec 3.17 step 5).
 */
export class PendingReferenceWorker implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly stopping = new AbortController();
  private loop?: Promise<void>;

  constructor(
    private readonly retry: RetryPendingReferences,
    private readonly logger: AppLogger,
    private readonly pollIntervalMs: number,
  ) {}

  onApplicationBootstrap(): void {
    this.loop = this.run();
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.stopping.abort();
    await this.loop;
  }

  private async run(): Promise<void> {
    const { signal } = this.stopping;
    while (!signal.aborted) {
      await this.tick();
      await pause(this.pollIntervalMs, signal);
    }
  }

  private async tick(): Promise<void> {
    try {
      await this.retry.execute();
    } catch (error) {
      this.logger.warn("pending reference tick failed", {
        event: "pending_reference.tick_failed",
        errorName: error instanceof Error ? error.name : typeof error,
      });
    }
  }
}

/** Resolves after `ms`, or at once when `signal` aborts. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}

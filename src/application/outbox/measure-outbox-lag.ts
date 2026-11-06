import type { Clock } from "../ports/clock.port";
import type { OutboxRepository } from "../ports/outbox.repository";
import type { UnitOfWork } from "../ports/unit-of-work.port";
import type { WageringMetrics } from "../ports/wagering-metrics.port";

const MS_PER_SECOND = 1000;

/** Samples the outbox lag (spec 3.18): the age of the oldest unpublished message, 0 when nothing is waiting. */
export class MeasureOutboxLag {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly outbox: OutboxRepository,
    private readonly clock: Clock,
    private readonly metrics: WageringMetrics,
  ) {}

  async execute(): Promise<number> {
    const oldest = await this.unitOfWork.isolated(() => this.outbox.oldestPendingOccurredAt());
    const lagSeconds = oldest ? Math.max(0, this.clock.now().getTime() - oldest.getTime()) / MS_PER_SECOND : 0;
    this.metrics.outboxLagObserved(lagSeconds);
    return lagSeconds;
  }
}

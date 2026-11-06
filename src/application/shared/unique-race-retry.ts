import { DuplicateRecordError, TransientInfrastructureError } from "../errors";
import type { UnitOfWork } from "../ports/unit-of-work.port";
import type { WageringMetrics } from "../ports/wagering-metrics.port";

/**
 * Runs the outermost unit of work and retries it once, in a fresh persistence context, when a concurrent writer won
 * a unique-key race (spec 3.8). The retry sees the committed row and answers with a replay, a conflict or a
 * rejection. A second race in a row is reported as transient.
 */
export class UniqueRaceRetry {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly metrics: WageringMetrics,
  ) {}

  async run<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await this.unitOfWork.isolated(work);
    } catch (error) {
      if (!(error instanceof DuplicateRecordError)) throw error;
      this.metrics.lockConflict("unique_race");
      this.metrics.retried("unique_race");
    }
    try {
      return await this.unitOfWork.isolated(work);
    } catch (error) {
      if (!(error instanceof DuplicateRecordError)) throw error;
      this.metrics.lockConflict("unique_race");
      throw new TransientInfrastructureError("Concurrent write conflict persisted after one retry", "unique_race", {
        cause: error,
      });
    }
  }
}

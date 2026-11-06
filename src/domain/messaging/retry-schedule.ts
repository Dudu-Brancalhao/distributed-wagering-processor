export type RandomSource = () => number;

export interface RetryScheduleProps {
  readonly baseMs: number;
  readonly capMs: number;
  /** Relative jitter applied to every delay; 0.2 means plus or minus 20%. */
  readonly jitterRatio?: number;
}

/** The single backoff policy: min(base * 2^attempt, cap) with symmetric relative jitter. */
export class RetrySchedule {
  private constructor(
    private readonly baseMs: number,
    private readonly capMs: number,
    private readonly jitterRatio: number,
  ) {}

  static of(props: RetryScheduleProps): RetrySchedule {
    const jitterRatio = props.jitterRatio ?? 0.2;
    if (props.baseMs <= 0 || props.capMs < props.baseMs) {
      throw new RangeError(`Invalid retry schedule: base ${props.baseMs} ms, cap ${props.capMs} ms`);
    }
    if (jitterRatio < 0 || jitterRatio >= 1) {
      throw new RangeError(`Invalid jitter ratio ${jitterRatio}`);
    }
    return new RetrySchedule(props.baseMs, props.capMs, jitterRatio);
  }

  /** Delay before retry number `attempt` (0-based), without jitter. */
  nominalDelayMs(attempt: number): number {
    if (!Number.isInteger(attempt) || attempt < 0) {
      throw new RangeError(`Invalid attempt ${attempt}`);
    }
    return Math.min(this.baseMs * 2 ** Math.min(attempt, 52), this.capMs);
  }

  delayMs(attempt: number, random: RandomSource = Math.random): number {
    const jitter = 1 + this.jitterRatio * (2 * random() - 1);
    return Math.round(this.nominalDelayMs(attempt) * jitter);
  }

  nextAttemptAt(attempt: number, now: Date, random: RandomSource = Math.random): Date {
    return new Date(now.getTime() + this.delayMs(attempt, random));
  }
}

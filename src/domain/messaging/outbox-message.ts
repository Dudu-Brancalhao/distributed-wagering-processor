import type { IntegrationEvent, IntegrationEventEnvelope } from "../events/integration-event";
import { InvalidMessageStateError } from "./messaging.errors";
import type { RandomSource, RetrySchedule } from "./retry-schedule";

export interface OutboxMessageState {
  readonly id: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly payload: Readonly<IntegrationEventEnvelope<unknown>>;
  readonly occurredAt: Date;
  readonly attempts: number;
  readonly nextAttemptAt?: Date;
  readonly publishedAt?: Date;
}

/** An integration event waiting to be published, written in the same SQL transaction as its cause. */
export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly payload: Readonly<IntegrationEventEnvelope<unknown>>,
    public readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt?: Date,
    private _publishedAt?: Date,
  ) {}

  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    return new OutboxMessage(
      event.eventId,
      event.aggregateId,
      event.eventType,
      event.toJSON(),
      event.occurredAt,
      0,
      event.occurredAt,
    );
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.eventType,
      state.payload,
      state.occurredAt,
      state.attempts,
      state.nextAttemptAt,
      state.publishedAt,
    );
  }

  get attempts(): number {
    return this._attempts;
  }

  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }

  get publishedAt(): Date | undefined {
    return this._publishedAt;
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    return this.isPending() && (this._nextAttemptAt ?? this.occurredAt).getTime() <= now.getTime();
  }

  markPublished(at: Date): void {
    this.assertPending();
    this._attempts += 1;
    this._publishedAt = at;
  }

  /** Counts the failed attempt and computes the next attempt time with the shared backoff policy. */
  scheduleRetry(now: Date, schedule: RetrySchedule, random?: RandomSource): void {
    this.assertPending();
    this._nextAttemptAt = schedule.nextAttemptAt(this._attempts, now, random);
    this._attempts += 1;
  }

  private assertPending(): void {
    if (!this.isPending()) {
      throw new InvalidMessageStateError(`Outbox message ${this.id} is already published`);
    }
  }
}

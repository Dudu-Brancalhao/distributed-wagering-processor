import type { Clock } from "../../application/ports/clock.port";

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

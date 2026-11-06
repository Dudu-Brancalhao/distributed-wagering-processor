import { Controller, Get, HttpStatus, Res } from "@nestjs/common";
import type { Response } from "express";
import { DatabaseHealthIndicator } from "../../infrastructure/persistence/database-health-indicator";
import { SqsHealthIndicator } from "../../infrastructure/sqs/sqs-health-indicator";
import { ShutdownState } from "./shutdown-state";

@Controller("health")
export class HealthController {
  constructor(
    private readonly database: DatabaseHealthIndicator,
    private readonly sqs: SqsHealthIndicator,
    private readonly shutdown: ShutdownState,
  ) {}

  /** Liveness: the process is up and its event loop answers. Never touches dependencies. */
  @Get("live")
  live(): { status: "ok" } {
    return { status: "ok" };
  }

  /** Readiness: PostgreSQL and SQS are reachable and the process is not shutting down. */
  @Get("ready")
  async ready(@Res({ passthrough: true }) response: Response) {
    const [postgres, sqs] = await Promise.all([this.database.check(), this.sqs.check()]);
    const shuttingDown = this.shutdown.isShuttingDown();
    const ready = postgres === "ok" && sqs === "ok" && !shuttingDown;
    response.status(ready ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    const status = ready ? "ok" : shuttingDown ? "shutting_down" : "unavailable";
    return { status, checks: { postgres, sqs } };
  }
}

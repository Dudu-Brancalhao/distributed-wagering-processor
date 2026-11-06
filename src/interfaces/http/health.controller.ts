import { Controller, Get, HttpStatus, Res } from "@nestjs/common";
import type { Response } from "express";
import { DatabaseHealthIndicator } from "../../infrastructure/persistence/database-health-indicator";

@Controller("health")
export class HealthController {
  constructor(private readonly database: DatabaseHealthIndicator) {}

  /** Liveness: the process is up and its event loop answers. Never touches dependencies. */
  @Get("live")
  live(): { status: "ok" } {
    return { status: "ok" };
  }

  /** Readiness: dependencies are reachable. The SQS check joins with the consumer slice. */
  @Get("ready")
  async ready(@Res({ passthrough: true }) response: Response) {
    const postgres = await this.database.check();
    const ready = postgres === "ok";
    response.status(ready ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return { status: ready ? "ok" : "unavailable", checks: { postgres } };
  }
}

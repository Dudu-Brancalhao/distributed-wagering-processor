import { Controller, Get } from "@nestjs/common";

@Controller("health")
export class HealthController {
  /** Liveness: the process is up and its event loop answers. Never touches dependencies. */
  @Get("live")
  live(): { status: "ok" } {
    return { status: "ok" };
  }
}

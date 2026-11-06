import type { EntityManager } from "@mikro-orm/postgresql";

export type DependencyStatus = "ok" | "unavailable";

/** Readiness probe for PostgreSQL: `SELECT 1` bounded by a timeout, so a frozen server reports quickly. */
export class DatabaseHealthIndicator {
  constructor(
    private readonly em: EntityManager,
    private readonly timeoutMs: number,
  ) {}

  async check(): Promise<DependencyStatus> {
    let timer: Timer | undefined;
    const timeout = new Promise<DependencyStatus>((resolve) => {
      timer = setTimeout(() => resolve("unavailable"), this.timeoutMs);
    });
    const probe = this.em
      .getConnection()
      .execute("select 1")
      .then((): DependencyStatus => "ok")
      .catch((): DependencyStatus => "unavailable");
    try {
      return await Promise.race([probe, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }
}

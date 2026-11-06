/**
 * Freezes and resumes the Compose PostgreSQL (spec 3.21), like `docker compose pause postgres`. The Compose project
 * is the one the standard `COMPOSE_PROJECT_NAME` and `COMPOSE_FILE` variables select, as for any `docker compose`.
 */
let paused = false;

export async function pausePostgres(): Promise<void> {
  await compose("pause", "postgres");
  paused = true;
}

/** Resumes PostgreSQL if this process paused it; safe to call from cleanup hooks. */
export async function unpausePostgres(): Promise<void> {
  if (!paused) return;
  await compose("unpause", "postgres");
  paused = false;
}

async function compose(...args: string[]): Promise<void> {
  const child = Bun.spawn(["docker", "compose", ...args], { stdout: "ignore", stderr: "pipe" });
  if ((await child.exited) !== 0) {
    throw new Error(`docker compose ${args.join(" ")} failed: ${await new Response(child.stderr).text()}`);
  }
}

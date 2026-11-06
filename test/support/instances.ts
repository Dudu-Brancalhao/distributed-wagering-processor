import { join } from "node:path";
import type { Subprocess } from "bun";
import { eventually } from "./eventually";
import { type HttpClient, httpClient } from "./test-app";
import { TEST_DATABASE_URL } from "./test-config";

const PROJECT_ROOT = join(import.meta.dir, "..", "..");
const READY_TIMEOUT_MS = 30_000;

export interface Instances {
  /** The instance that serves request number `index`, spreading requests round-robin. */
  pick(index: number): HttpClient;
  close(): Promise<void>;
}

/**
 * Spawns `count` separate OS processes of the real application (`bun src/main.ts`, API role) on distinct ports against
 * the test database, and resolves once every one answers `/health/ready` (spec 3.21).
 */
export async function spawnInstances(count: number): Promise<Instances> {
  const processes: Subprocess[] = [];
  const clients: HttpClient[] = [];
  try {
    for (let index = 1; index <= count; index++) {
      const port = freePort();
      processes.push(spawnApp(port, `concurrency-${index}`));
      clients.push(httpClient(`http://127.0.0.1:${port}`));
    }
    await Promise.all(clients.map(waitUntilReady));
  } catch (error) {
    await stopAll(processes);
    throw error;
  }
  return {
    pick(index) {
      const client = clients[index % clients.length];
      if (!client) throw new Error("no instance spawned");
      return client;
    },
    close: () => stopAll(processes),
  };
}

function spawnApp(port: number, instanceId: string): Subprocess {
  return Bun.spawn(["bun", "src/main.ts"], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      DATABASE_URL: TEST_DATABASE_URL,
      APP_ROLES: "api",
      PORT: String(port),
      INSTANCE_ID: instanceId,
      LOG_LEVEL: "warn",
    },
    stdout: "ignore",
    stderr: "inherit",
  });
}

/** A port the OS reports free right now; the spawned process binds it moments later. */
function freePort(): number {
  const server = Bun.serve({ port: 0, fetch: () => new Response() });
  const { port } = server;
  server.stop(true);
  if (port === undefined) throw new Error("the OS assigned no port");
  return port;
}

function waitUntilReady(client: HttpClient): Promise<void> {
  return eventually(
    async () => {
      const response = await client.request("GET", "/health/ready");
      if (response.status !== 200) throw new Error(`${client.baseUrl} is not ready: ${response.status}`);
    },
    { timeoutMs: READY_TIMEOUT_MS },
  );
}

async function stopAll(processes: readonly Subprocess[]): Promise<void> {
  for (const child of processes) child.kill("SIGTERM");
  await Promise.all(processes.map((child) => child.exited));
}

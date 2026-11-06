import { join } from "node:path";
import type { Subprocess } from "bun";
import { eventually } from "./eventually";
import { type HttpClient, httpClient } from "./test-app";
import { TEST_DATABASE_URL } from "./test-config";

const PROJECT_ROOT = join(import.meta.dir, "..", "..");
const READY_TIMEOUT_MS = 30_000;

export interface SpawnOptions {
  /** `APP_ROLES` of every process; the API role alone by default. */
  readonly roles?: string;
  /** Extra environment, such as the queue names of the test and shortened intervals. */
  readonly env?: Readonly<Record<string, string>>;
  /** Script run instead of `src/main.ts`, such as a crash entrypoint of `test/support/entrypoints`. */
  readonly entrypoint?: string;
}

export interface Instances {
  /** The instance that serves request number `index`, spreading requests round-robin. */
  pick(index: number): HttpClient;
  /** Sends `signal` to every process and resolves once all of them have exited. */
  kill(signal: NodeJS.Signals): Promise<void>;
  /** Resolves once every process has exited, with the signal that ended each one (`null` for a normal exit). */
  exited(): Promise<Subprocess["signalCode"][]>;
  close(): Promise<void>;
}

/**
 * Spawns `count` separate OS processes of the real application (`bun src/main.ts` unless another entrypoint is given)
 * on distinct ports against the test database, and resolves once every one answers `/health/ready` (spec 3.21).
 */
export async function spawnInstances(count: number, options: SpawnOptions = {}): Promise<Instances> {
  const processes: Subprocess[] = [];
  const clients: HttpClient[] = [];
  const kill = async (signal: NodeJS.Signals) => {
    for (const child of processes) child.kill(signal);
    await Promise.all(processes.map((child) => child.exited));
  };
  try {
    for (let index = 1; index <= count; index++) {
      const port = freePort();
      processes.push(spawnApp(port, `concurrency-${index}`, options));
      clients.push(httpClient(`http://127.0.0.1:${port}`));
    }
    await Promise.all(clients.map(waitUntilReady));
  } catch (error) {
    await kill("SIGTERM");
    throw error;
  }
  return {
    pick(index) {
      const client = clients[index % clients.length];
      if (!client) throw new Error("no instance spawned");
      return client;
    },
    kill,
    async exited() {
      await Promise.all(processes.map((child) => child.exited));
      return processes.map((child) => child.signalCode);
    },
    close: () => kill("SIGTERM"),
  };
}

function spawnApp(port: number, instanceId: string, options: SpawnOptions): Subprocess {
  return Bun.spawn(["bun", options.entrypoint ?? "src/main.ts"], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      DATABASE_URL: TEST_DATABASE_URL,
      APP_ROLES: options.roles ?? "api",
      PORT: String(port),
      INSTANCE_ID: instanceId,
      LOG_LEVEL: "warn",
      ...options.env,
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

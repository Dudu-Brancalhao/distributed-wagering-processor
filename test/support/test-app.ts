import { Writable } from "node:stream";
import type { INestApplication } from "@nestjs/common";
import { Test, type TestingModuleBuilder } from "@nestjs/testing";
import type { DestinationStream } from "pino";
import { AppModule } from "../../src/app.module";
import { createApp } from "../../src/bootstrap";
import type { AppConfig } from "../../src/infrastructure/config/config.schema";
import { createMetricsRegistry } from "../../src/infrastructure/observability/metrics-registry";
import { NestLoggerAdapter } from "../../src/infrastructure/observability/nest-logger.adapter";
import { createPino } from "../../src/infrastructure/observability/pino-logger";
import { testConfig } from "./test-config";

export interface HttpResponse {
  readonly status: number;
  readonly headers: Headers;
  // biome-ignore lint/suspicious/noExplicitAny: test assertions read arbitrary JSON bodies
  readonly body: any;
}

/** JSON requests against one running application, in process or spawned. */
export interface HttpClient {
  readonly baseUrl: string;
  request(
    method: string,
    path: string,
    options?: { body?: unknown; headers?: Record<string, string> },
  ): Promise<HttpResponse>;
}

export interface TestApp extends HttpClient {
  readonly app: INestApplication;
  readonly logLines: string[];
  close(): Promise<void>;
}

export function httpClient(baseUrl: string): HttpClient {
  return {
    baseUrl,
    async request(method, path, { body, headers = {} } = {}) {
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: { "content-type": "application/json", ...headers },
        body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
      });
      const text = await response.text();
      return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : undefined };
    },
  };
}

/** The real application (every adapter real) listening on a random port, with its log lines captured. */
export async function startTestApp(overrides: Record<string, string> = {}): Promise<TestApp> {
  const logs = captureLogs();
  return listen(await createApp(testConfig(overrides), logs.sink), logs.lines);
}

/**
 * The same application with providers replaced through `customize`, for fault injection without production hooks
 * (spec 3.21).
 */
export async function startCustomizedTestApp(
  overrides: Record<string, string>,
  customize: (builder: TestingModuleBuilder) => TestingModuleBuilder,
): Promise<TestApp> {
  const logs = captureLogs();
  return listen(await createCustomizedApp(testConfig(overrides), customize, logs.sink), logs.lines);
}

/** Builds the application like `createApp`, with providers replaced through `customize`, without listening. */
export async function createCustomizedApp(
  config: AppConfig,
  customize: (builder: TestingModuleBuilder) => TestingModuleBuilder,
  destination?: DestinationStream,
): Promise<INestApplication> {
  const logger = createPino({
    level: config.LOG_LEVEL,
    instanceId: config.INSTANCE_ID,
    roles: config.APP_ROLES,
    destination,
  });
  const registry = createMetricsRegistry(config.INSTANCE_ID);
  const moduleRef = await customize(
    Test.createTestingModule({ imports: [AppModule.forRoot({ config, logger, registry })] }),
  ).compile();
  return moduleRef.createNestApplication({ logger: new NestLoggerAdapter(logger) });
}

function captureLogs() {
  const lines: string[] = [];
  const sink = new Writable({
    write(chunk, _encoding, done) {
      lines.push(...String(chunk).split("\n").filter(Boolean));
      done();
    },
  });
  return { lines, sink };
}

async function listen(app: INestApplication, logLines: string[]): Promise<TestApp> {
  await app.listen(0);
  return { ...httpClient(await app.getUrl()), app, logLines, close: () => app.close() };
}

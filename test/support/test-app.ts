import { Writable } from "node:stream";
import type { INestApplication } from "@nestjs/common";
import { createApp } from "../../src/bootstrap";
import { testConfig } from "./test-config";

export interface HttpResponse {
  readonly status: number;
  readonly headers: Headers;
  // biome-ignore lint/suspicious/noExplicitAny: test assertions read arbitrary JSON bodies
  readonly body: any;
}

export interface TestApp {
  readonly app: INestApplication;
  readonly baseUrl: string;
  readonly logLines: string[];
  request(
    method: string,
    path: string,
    options?: { body?: unknown; headers?: Record<string, string> },
  ): Promise<HttpResponse>;
  close(): Promise<void>;
}

/** The real application (every adapter real) listening on a random port, with its log lines captured. */
export async function startTestApp(overrides: Record<string, string> = {}): Promise<TestApp> {
  const logLines: string[] = [];
  const sink = new Writable({
    write(chunk, _encoding, done) {
      logLines.push(...String(chunk).split("\n").filter(Boolean));
      done();
    },
  });
  const app = await createApp(testConfig(overrides), sink);
  await app.listen(0);
  const baseUrl = await app.getUrl();
  return {
    app,
    baseUrl,
    logLines,
    async request(method, path, { body, headers = {} } = {}) {
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: { "content-type": "application/json", ...headers },
        body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
      });
      const text = await response.text();
      return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : undefined };
    },
    close: () => app.close(),
  };
}

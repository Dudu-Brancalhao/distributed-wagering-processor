import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Writable } from "node:stream";
import type { INestApplication } from "@nestjs/common";
import { createApp } from "../../../src/bootstrap";
import { appConfigSchema } from "../../../src/infrastructure/config/config.schema";
import { loadConfig } from "../../../src/infrastructure/config/load-config";

const logLines: string[] = [];
const sink = new Writable({
  write(chunk, _encoding, done) {
    logLines.push(...String(chunk).split("\n").filter(Boolean));
    done();
  },
});

let app: INestApplication;
let baseUrl: string;

beforeAll(async () => {
  const config = loadConfig(appConfigSchema, {
    DATABASE_URL: "postgres://unused@localhost:5432/unused",
    APP_ROLES: "api",
    INSTANCE_ID: "test-instance",
  });
  app = await createApp(config, sink);
  await app.listen(0);
  baseUrl = await app.getUrl();
});

afterAll(async () => {
  await app.close();
});

describe("HTTP edge", () => {
  test("GET /health/live answers without touching dependencies", async () => {
    const response = await fetch(`${baseUrl}/health/live`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  test("assigns and echoes correlation and request ids", async () => {
    const generated = await fetch(`${baseUrl}/health/live`);
    expect(generated.headers.get("x-correlation-id")).toMatch(/^[0-9a-f-]{36}$/);
    expect(generated.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);

    const propagated = await fetch(`${baseUrl}/health/live`, { headers: { "X-Correlation-Id": "corr-123" } });
    expect(propagated.headers.get("x-correlation-id")).toBe("corr-123");

    const invalid = await fetch(`${baseUrl}/health/live`, { headers: { "X-Correlation-Id": "bad id with spaces" } });
    expect(invalid.headers.get("x-correlation-id")).not.toBe("bad id with spaces");
  });

  test("GET /metrics exposes Prometheus text with the instance label", async () => {
    const response = await fetch(`${baseUrl}/metrics`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(await response.text()).toContain('instance_id="test-instance"');
  });

  test("logs are JSON lines with the instance id and roles", () => {
    expect(logLines.length).toBeGreaterThan(0);
    for (const line of logLines) {
      const entry = JSON.parse(line);
      expect(entry).toMatchObject({ instanceId: "test-instance", roles: "api" });
      expect(typeof entry.level).toBe("string");
    }
  });
});

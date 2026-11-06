import { describe, expect, test } from "bun:test";
import { appConfigSchema, sqsConfigSchema } from "../../../src/infrastructure/config/config.schema";
import { InvalidConfigError, loadConfig } from "../../../src/infrastructure/config/load-config";

const base = { DATABASE_URL: "postgres://wagering:wagering@localhost:5432/wagering" };

describe("configuration", () => {
  test("applies the spec defaults", () => {
    const config = loadConfig(appConfigSchema, base);
    expect(config.APP_ROLES).toEqual(["api", "consumer", "outbox", "pending-reference"]);
    expect(config.PORT).toBe(3000);
    expect(config.PENDING_REFERENCE_MAX_ATTEMPTS).toBe(20);
    expect(config.PENDING_REFERENCE_RETRY_MAX_MS).toBe(300_000);
    expect(config.SQS_WAGER_QUEUE_NAME).toBe("wager-transactions.fifo");
  });

  test("parses and deduplicates roles", () => {
    expect(loadConfig(appConfigSchema, { ...base, APP_ROLES: "api, outbox,api" }).APP_ROLES).toEqual(["api", "outbox"]);
  });

  test.each([
    [{ APP_ROLES: "api,worker" }],
    [{ APP_ROLES: "" }],
    [{ PORT: "abc" }],
    [{ DATABASE_URL: "not a url" }],
    [{ SQS_WAGER_QUEUE_NAME: "standard-queue" }],
    [{ SQS_BATCH_SIZE: "11" }],
  ])("fails fast on %p", (override) => {
    expect(() => loadConfig(appConfigSchema, { ...base, ...override })).toThrow(InvalidConfigError);
  });

  test("requires DATABASE_URL for the app but not for SQS tooling", () => {
    expect(() => loadConfig(appConfigSchema, {})).toThrow(InvalidConfigError);
    expect(loadConfig(sqsConfigSchema, {}).SQS_ENDPOINT).toBe("http://localhost:4566");
  });
});

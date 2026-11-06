import { type AppConfig, appConfigSchema } from "../../src/infrastructure/config/config.schema";
import { loadConfig } from "../../src/infrastructure/config/load-config";

/** The Compose PostgreSQL creates `wagering_test` for the integration and concurrency suites. */
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://wagering:wagering@localhost:5432/wagering_test";

export function testConfig(overrides: Record<string, string> = {}): AppConfig {
  return loadConfig(appConfigSchema, {
    ...process.env,
    DATABASE_URL: TEST_DATABASE_URL,
    APP_ROLES: "api",
    INSTANCE_ID: "integration",
    LOG_LEVEL: "info",
    ...overrides,
  });
}

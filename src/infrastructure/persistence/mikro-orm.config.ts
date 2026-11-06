import { Migrator } from "@mikro-orm/migrations";
import { defineConfig, type Options, PostgreSqlDriver } from "@mikro-orm/postgresql";
import type { DatabaseConfig } from "../config/config.schema";
import { InitialSchemaMigration } from "./migrations/20261106000000-initial-schema.migration";
import { PERSISTENCE_SCHEMAS } from "./persistence-schemas";

/**
 * Session timeouts are server-side settings sent at connect time; the client-side timeouts cover a server that does
 * not answer at all (spec 3.4). `driverOptions` is merged into the `pg` pool configuration.
 */
export function mikroOrmOptions(config: DatabaseConfig): Options {
  const sessionSettings = [
    `lock_timeout=${config.DB_LOCK_TIMEOUT_MS}`,
    `statement_timeout=${config.DB_STATEMENT_TIMEOUT_MS}`,
    `transaction_timeout=${config.DB_TRANSACTION_TIMEOUT_MS}`,
    `idle_in_transaction_session_timeout=${config.DB_IDLE_IN_TRANSACTION_TIMEOUT_MS}`,
  ];
  return defineConfig({
    driver: PostgreSqlDriver,
    clientUrl: config.DATABASE_URL,
    entities: PERSISTENCE_SCHEMAS,
    allowGlobalContext: false,
    pool: { max: config.DB_POOL_MAX },
    driverOptions: {
      options: sessionSettings.map((setting) => `-c ${setting}`).join(" "),
      connectionTimeoutMillis: config.DB_CONNECT_TIMEOUT_MS,
      query_timeout: config.DB_QUERY_TIMEOUT_MS,
      keepAlive: true,
    },
    extensions: [Migrator],
    migrations: {
      migrationsList: [{ name: "20261106000000_initial_schema", class: InitialSchemaMigration }],
      transactional: true,
      allOrNothing: true,
      snapshot: false,
      silent: true,
    },
  });
}

import { MikroORM } from "@mikro-orm/postgresql";
import { databaseConfigSchema } from "../src/infrastructure/config/config.schema";
import { loadConfig } from "../src/infrastructure/config/load-config";
import { mikroOrmOptions } from "../src/infrastructure/persistence/mikro-orm.config";

/** `up` applies every pending migration; `down` reverts the last one. Each run is all-or-nothing. */
const direction = process.argv[2] ?? "up";
if (direction !== "up" && direction !== "down") {
  console.error(JSON.stringify({ event: "db.migrations_failed", reason: `unknown direction "${direction}"` }));
  process.exit(1);
}

const orm = await MikroORM.init(mikroOrmOptions(loadConfig(databaseConfigSchema)));
try {
  const applied = direction === "up" ? await orm.migrator.up() : await orm.migrator.down();
  console.log(JSON.stringify({ event: `db.migrations_${direction}`, migrations: applied.map((m) => m.name) }));
} finally {
  await orm.close();
}

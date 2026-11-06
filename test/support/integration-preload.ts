import { MikroORM } from "@mikro-orm/postgresql";
import { mikroOrmOptions } from "../../src/infrastructure/persistence/mikro-orm.config";
import { testConfig } from "./test-config";

/** Brings `wagering_test` to the latest schema once per run. Tests never truncate: each one uses its own ids. */
const orm = await MikroORM.init(mikroOrmOptions(testConfig()));
try {
  await orm.migrator.up();
} finally {
  await orm.close();
}

import { MikroORM } from "@mikro-orm/postgresql";
import { mikroOrmOptions } from "../../src/infrastructure/persistence/mikro-orm.config";
import { provisionTestQueues } from "./sqs-test-queues";
import { testConfig } from "./test-config";

/** Brings `wagering_test` to the latest schema once per run. Tests never truncate: each one uses its own ids. */
const orm = await MikroORM.init(mikroOrmOptions(testConfig()));
try {
  await orm.migrator.up();
} finally {
  await orm.close();
}

/**
 * Queues for this run, so every application is ready (spec 3.13). Tests that put messages on a queue provision
 * their own queues instead.
 */
Object.assign(process.env, (await provisionTestQueues()).names);

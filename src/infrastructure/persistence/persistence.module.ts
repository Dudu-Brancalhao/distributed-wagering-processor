import { MikroOrmModule } from "@mikro-orm/nestjs";
import { EntityManager, PostgreSqlDriver } from "@mikro-orm/postgresql";
import { Global, type InjectionToken, Module } from "@nestjs/common";
import { APP_CONFIG } from "../config/app-config.token";
import type { AppConfig } from "../config/config.schema";
import { DatabaseHealthIndicator } from "./database-health-indicator";
import { mikroOrmOptions } from "./mikro-orm.config";
import { MikroOrmUnitOfWork } from "./mikro-orm-unit-of-work";
import {
  LEDGER_REPOSITORY,
  OUTBOX_REPOSITORY,
  UNIT_OF_WORK,
  WAGER_TRANSACTION_REPOSITORY,
  WALLET_REPOSITORY,
} from "./persistence.tokens";
import { MikroOrmLedgerRepository } from "./repositories/mikro-orm-ledger.repository";
import { MikroOrmOutboxRepository } from "./repositories/mikro-orm-outbox.repository";
import { MikroOrmWagerTransactionRepository } from "./repositories/mikro-orm-wager-transaction.repository";
import { MikroOrmWalletRepository } from "./repositories/mikro-orm-wallet.repository";

const READINESS_TIMEOUT_MS = 1000;

/** Every adapter receives the context-resolved EntityManager (spec 3.4 rule 1). */
const withEntityManager = <T>(provide: InjectionToken, build: (em: EntityManager) => T) => ({
  provide,
  useFactory: build,
  inject: [EntityManager],
});

@Global()
@Module({
  imports: [
    MikroOrmModule.forRootAsync({
      driver: PostgreSqlDriver,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => mikroOrmOptions(config),
    }),
  ],
  providers: [
    withEntityManager(UNIT_OF_WORK, (em) => new MikroOrmUnitOfWork(em)),
    withEntityManager(WALLET_REPOSITORY, (em) => new MikroOrmWalletRepository(em)),
    withEntityManager(WAGER_TRANSACTION_REPOSITORY, (em) => new MikroOrmWagerTransactionRepository(em)),
    withEntityManager(LEDGER_REPOSITORY, (em) => new MikroOrmLedgerRepository(em)),
    withEntityManager(OUTBOX_REPOSITORY, (em) => new MikroOrmOutboxRepository(em)),
    withEntityManager(DatabaseHealthIndicator, (em) => new DatabaseHealthIndicator(em, READINESS_TIMEOUT_MS)),
  ],
  exports: [
    UNIT_OF_WORK,
    WALLET_REPOSITORY,
    WAGER_TRANSACTION_REPOSITORY,
    LEDGER_REPOSITORY,
    OUTBOX_REPOSITORY,
    DatabaseHealthIndicator,
  ],
})
export class PersistenceModule {}

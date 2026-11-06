import { Global, Module } from "@nestjs/common";
import type { AppLogger } from "./application/ports/app-logger.port";
import type { Clock } from "./application/ports/clock.port";
import type { IdGenerator } from "./application/ports/id-generator.port";
import type { LedgerRepository } from "./application/ports/ledger.repository";
import type { OutboxRepository } from "./application/ports/outbox.repository";
import type { UnitOfWork } from "./application/ports/unit-of-work.port";
import type { WagerTransactionRepository } from "./application/ports/wager-transaction.repository";
import type { WageringMetrics } from "./application/ports/wagering-metrics.port";
import type { WalletRepository } from "./application/ports/wallet.repository";
import { UniqueRaceRetry } from "./application/shared/unique-race-retry";
import { GetWagerTransaction } from "./application/wagering/get-wager-transaction";
import { SubmissionTelemetry } from "./application/wagering/submission-telemetry";
import { SubmitWagerTransaction } from "./application/wagering/submit-wager-transaction";
import { CreateWallet } from "./application/wallets/create-wallet";
import { GetWallet } from "./application/wallets/get-wallet";
import { ListWalletLedger } from "./application/wallets/list-wallet-ledger";
import { ReconcileWallet } from "./application/wallets/reconcile-wallet";
import { RetrySchedule } from "./domain/messaging/retry-schedule";
import { WagerTransactionProcessor } from "./domain/wagering/wager-transaction-processor";
import { APP_CONFIG } from "./infrastructure/config/app-config.token";
import type { AppConfig } from "./infrastructure/config/config.schema";
import { APP_LOGGER, WAGERING_METRICS } from "./infrastructure/observability/observability.tokens";
import {
  LEDGER_REPOSITORY,
  OUTBOX_REPOSITORY,
  UNIT_OF_WORK,
  WAGER_TRANSACTION_REPOSITORY,
  WALLET_REPOSITORY,
} from "./infrastructure/persistence/persistence.tokens";
import { CLOCK, ID_GENERATOR } from "./infrastructure/runtime/runtime.tokens";
import { SystemClock } from "./infrastructure/runtime/system-clock";
import { UuidV7Generator } from "./infrastructure/runtime/uuid-v7-generator";

const USE_CASES = [
  SubmitWagerTransaction,
  GetWagerTransaction,
  CreateWallet,
  GetWallet,
  ListWalletLedger,
  ReconcileWallet,
];

/** Builds the framework-free use cases from their ports. Shared by every driving adapter (HTTP now, SQS later). */
@Global()
@Module({
  providers: [
    { provide: CLOCK, useValue: new SystemClock() },
    { provide: ID_GENERATOR, useValue: new UuidV7Generator() },
    {
      provide: WagerTransactionProcessor,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) =>
        new WagerTransactionProcessor({
          schedule: RetrySchedule.of({
            baseMs: config.PENDING_REFERENCE_RETRY_BASE_MS,
            capMs: config.PENDING_REFERENCE_RETRY_MAX_MS,
          }),
          maxAttempts: config.PENDING_REFERENCE_MAX_ATTEMPTS,
        }),
    },
    {
      provide: UniqueRaceRetry,
      inject: [UNIT_OF_WORK, WAGERING_METRICS],
      useFactory: (unitOfWork: UnitOfWork, metrics: WageringMetrics) => new UniqueRaceRetry(unitOfWork, metrics),
    },
    {
      provide: SubmissionTelemetry,
      inject: [APP_LOGGER, WAGERING_METRICS],
      useFactory: (logger: AppLogger, metrics: WageringMetrics) => new SubmissionTelemetry(logger, metrics),
    },
    {
      provide: SubmitWagerTransaction,
      inject: [
        UNIT_OF_WORK,
        UniqueRaceRetry,
        WALLET_REPOSITORY,
        WAGER_TRANSACTION_REPOSITORY,
        LEDGER_REPOSITORY,
        OUTBOX_REPOSITORY,
        WagerTransactionProcessor,
        CLOCK,
        ID_GENERATOR,
        WAGERING_METRICS,
        SubmissionTelemetry,
      ],
      useFactory: (
        unitOfWork: UnitOfWork,
        raceRetry: UniqueRaceRetry,
        wallets: WalletRepository,
        transactions: WagerTransactionRepository,
        ledger: LedgerRepository,
        outbox: OutboxRepository,
        processor: WagerTransactionProcessor,
        clock: Clock,
        ids: IdGenerator,
        metrics: WageringMetrics,
        telemetry: SubmissionTelemetry,
      ) =>
        new SubmitWagerTransaction({
          unitOfWork,
          raceRetry,
          wallets,
          transactions,
          ledger,
          outbox,
          processor,
          clock,
          ids,
          metrics,
          telemetry,
        }),
    },
    {
      provide: CreateWallet,
      inject: [
        UNIT_OF_WORK,
        WALLET_REPOSITORY,
        WAGER_TRANSACTION_REPOSITORY,
        LEDGER_REPOSITORY,
        OUTBOX_REPOSITORY,
        CLOCK,
        ID_GENERATOR,
      ],
      useFactory: (
        unitOfWork: UnitOfWork,
        wallets: WalletRepository,
        transactions: WagerTransactionRepository,
        ledger: LedgerRepository,
        outbox: OutboxRepository,
        clock: Clock,
        ids: IdGenerator,
      ) => new CreateWallet({ unitOfWork, wallets, transactions, ledger, outbox, clock, ids }),
    },
    {
      provide: GetWagerTransaction,
      inject: [WAGER_TRANSACTION_REPOSITORY],
      useFactory: (transactions: WagerTransactionRepository) => new GetWagerTransaction(transactions),
    },
    {
      provide: GetWallet,
      inject: [WALLET_REPOSITORY],
      useFactory: (wallets: WalletRepository) => new GetWallet(wallets),
    },
    {
      provide: ListWalletLedger,
      inject: [WALLET_REPOSITORY, LEDGER_REPOSITORY],
      useFactory: (wallets: WalletRepository, ledger: LedgerRepository) => new ListWalletLedger(wallets, ledger),
    },
    {
      provide: ReconcileWallet,
      inject: [LEDGER_REPOSITORY, WAGERING_METRICS, APP_LOGGER],
      useFactory: (ledger: LedgerRepository, metrics: WageringMetrics, logger: AppLogger) =>
        new ReconcileWallet(ledger, metrics, logger),
    },
  ],
  exports: USE_CASES,
})
export class UseCasesModule {}

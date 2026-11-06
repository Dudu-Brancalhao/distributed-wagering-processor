# Distributed Wagering Processor - Implementation Spec

| | |
|---|---|
| Status | Approved. Every open question in section 4 is decided (2026-11-06); the outcome is recorded under each item. |
| Source of truth | `docs/challenge.md` (pt-BR). If this spec and the challenge disagree, the challenge wins and this spec gets fixed. |
| Audience | Engineers and coding agents implementing the service. |
| Scope | The scored core of the challenge (section 14 of the challenge). Optional differentials happen only if section 4 approves them and time remains. |

Keywords MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119. Identifiers are traceable: `P-x` principles, `R-xx` requirements, `E-xx` eliminatory acceptance checks, `T-xx` tests, `OQ-xx` open questions, `S-xx` delivery slices.

The project's system design diagram is a separate, hand-drawn deliverable. This spec deliberately contains no diagrams. Components, flows and boundaries are described in prose and tables.

---

## 1. Principles

Every change (every PR, every slice) MUST satisfy both principles. A reviewer checks each rule below. A change that breaks one is not merged.

### P-1 Code quality: SOLID, KISS, Clean Code

| Rule | Check |
|---|---|
| P-1.1 Single responsibility | Each class and function does one thing that can be named without "and". Use cases orchestrate. Domain objects hold rules. Adapters translate between the outside world and ports. Mixed responsibilities are split before merge. |
| P-1.2 Dependency rule | `src/domain` imports nothing outside `src/domain` (no `@nestjs/*`, `@mikro-orm/*`, `pg`, `@aws-sdk/*`, `pino`, `prom-client`, `zod`). `src/application` imports only `src/domain`, its own ports and Node standard-library modules (`node:*`, for example `node:crypto` for the payload hash). Only `src/infrastructure`, `src/interfaces` and the composition root (`src/main.ts`, `src/*.module.ts`) may import frameworks. Enforced by `test/unit/architecture.test.ts`, which scans import statements. |
| P-1.3 Encapsulated domain | Domain classes have `private` or `protected` constructors and static factories (`create`, `from`, `rehydrate`, `open`, `receive`, `enqueue`). There are no public setters. State changes only through named transition methods. `rehydrate` rebuilds persisted state without revalidating transitions. |
| P-1.4 Dependency inversion | Use cases depend on ports (interfaces in `src/application/ports`), never on adapters. Adapters are wired in Nest modules with factory providers. |
| P-1.5 KISS | No abstraction without a current requirement or a second caller. Prefer a PostgreSQL feature (constraint, index, trigger, `SKIP LOCKED`) over application machinery. No generic frameworks, base repositories or event buses beyond what this spec names. |
| P-1.6 Clean Code | Intention-revealing names. Functions stay short and single-level. No dead code, no commented-out code, no `any` (lint error). No magic numbers: tunables live in validated configuration (section 3.19). |
| P-1.7 Money safety | No `number` for money anywhere: domain, DTOs, message schemas, DB columns, events, logs. JSON numbers in a money field are a validation error. |
| P-1.8 Quality gates | `bun run check` (typecheck with `tsc --noEmit`, Biome lint and format check, unit tests) passes locally. Integration and concurrency suites pass for the slices they cover. No new lint warnings, no flaky tests: a flaky test is a bug and gets fixed or removed in the same PR. |
| P-1.9 Tests with behavior | Every behavior change ships with the tests named in its slice (section 5). Tests assert outcomes, not implementation details. |

### P-2 Language

| Rule | Check |
|---|---|
| P-2.1 English for code | Source code, identifiers, comments, commit messages, log messages, metric names, error `message` fields in API responses, test names and technical docs (`docs/spec.md`) are in English. |
| P-2.2 pt-BR for stakeholders | `README.md` and OpenAPI descriptions (if OpenAPI is approved in OQ-06) are in Portuguese (pt-BR). `ARCHITECTURE.md` is also in pt-BR (OQ-12). |
| P-2.3 Stable machine codes | Failure codes, error codes, event types, metric names and enum values are English `UPPER_SNAKE_CASE` or `snake_case` identifiers and never get translated. |

---

## 2. Requirements

### 2.1 Evaluation areas

Area keys used in the requirement table, with the challenge's points (challenge section 14):

| Key | Area (challenge wording) | Points | Requirements |
|---|---|---|---|
| FIN | Correção financeira | 20 | R-02, R-05, R-09, R-13, R-15, R-16, R-18, R-20 to R-26, R-28, R-29, R-32, R-35 to R-37, R-41, R-52, R-64 |
| CON | Concorrência | 20 | R-01, R-02, R-07, R-10 to R-13, R-16, R-33 to R-35, R-63 |
| IDE | Idempotência | 15 | R-06, R-17, R-27, R-38, R-39, R-40, R-46, R-51 |
| MSG | Mensageria e falhas | 15 | R-01, R-02, R-07, R-08, R-19, R-28, R-31, R-34, R-40, R-44 to R-56 |
| MOD | Modelagem e arquitetura | 10 | R-03, R-04, R-13 to R-15, R-17 to R-19, R-37, R-45, R-56 |
| TST | Testes | 10 | R-61 to R-64 |
| OBS | Observabilidade | 5 | R-41, R-42, R-57 to R-60 |
| DOC | Documentação | 5 | R-04, R-30, R-32, R-43, R-65 |
| - | Autenticação (0 points) | 0 | R-43 |

### 2.2 Requirement list

"Source" points to a section of `docs/challenge.md`. "Verified by" points to tests in section 3.21 or to a document.

| ID | Requirement | Source | Area | Verified by |
|---|---|---|---|---|
| R-01 | The system stays correct when messages are duplicated, delivered out of order, or processed simultaneously; when several instances touch the same wallet; when a process dies before or after commit; when events are published more than once; when PostgreSQL or SQS is temporarily unavailable. | 1, 3 | CON, MSG | T-C1 to T-C8, T-I5, T-I6 |
| R-02 | Global invariants: never duplicate a credit or a debit, never lose a committed event, never allow a negative balance. | 3 | FIN, CON, MSG | E-02, E-03, E-06, T-C* |
| R-03 | Stack: Bun 1.x as runtime, package manager and test runner; TypeScript strict; NestJS; PostgreSQL; SQS through LocalStack or MiniStack; Docker Compose; versioned and reversible migrations. | 4 | MOD | S-01, T-I1 |
| R-04 | Exactly one ORM: MikroORM (preferred) or TypeORM. Prisma and others are out. The ORM choice, the `Money` mapping and the transaction strategy are justified in `ARCHITECTURE.md`. | 4 | MOD, DOC | S-03, S-10 |
| R-05 | No `number`, `float` or `double` for money. | 5.1 | FIN | E-01 |
| R-06 | No in-memory cache as an idempotency guarantee. | 5.2 | IDE | E-04 |
| R-07 | Consistency does not rely only on SQS FIFO. | 5.3 | CON, MSG | SQS variants of T-C1, T-C2, T-C4 (random `MessageGroupId` and distinct deduplication ids, so the broker can neither serialize nor deduplicate) |
| R-08 | No event is published before the financial transaction commits. | 5.4 | MSG | E-06, T-I2 |
| R-09 | Ledger entries are never overwritten or deleted. | 5.5 | FIN | T-I1 (triggers), E-07 |
| R-10 | No global lock shared by all wallets. | 5.6 | CON | Design 3.9, T-C3 |
| R-11 | No balance `read -> calculate -> update` without concurrency control. | 5.7 | CON | Design 3.9, T-C2 |
| R-12 | Correct with multiple application instances. | 5.8 | CON | T-C4, E-05 |
| R-13 | Uniqueness, immutability and non-negativity are enforced by the database schema (constraints, indexes, triggers), not only by application code. | 5.9 | FIN, CON, MOD | T-I1 |
| R-14 | Domain classes use `private`/`protected` constructors and static factories (`create`, `from`, `rehydrate`). `rehydrate` does not revalidate transitions. | 6.0 | MOD | P-1.3, T-U2 to T-U4 |
| R-15 | `Money` is immutable and offers `from`, `zero`, `add`, `subtract`, `negate`, `isZero`, `isPositive`, `isNegative`, `isLessThan`, `equals`, `toJSON`, `toString`. Amounts are received and serialized as decimal strings with a fixed scale of 2. Operations across currencies throw a domain error. It rejects `NaN`, `Infinity`, scientific notation, empty strings, more than 2 decimals and negative values in input contracts. The domain does not depend on ORM money types or NestJS decorators. Persistence is exact and rehydrates as `Money`. The model stays multi-currency (BRL by default) and currency conflicts are tested. | 6.1 | FIN, MOD | T-U1 |
| R-16 | Wallet invariants: at most one wallet per `playerId` + `currency`; balance never negative; every balance change has exactly one ledger entry and vice versa; no lost update; operation currency equals wallet currency; `version` is 1 after creation and increments only when the balance changes. | 6.2 | FIN, CON | T-U2, T-I1, T-C2 |
| R-17 | `WagerTransaction` has the kinds `OPENING`, `BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK` and the statuses `PENDING`, `PENDING_REFERENCE`, `PROCESSED`, `REJECTED`, `FAILED`. It is born `PENDING` and `create` validates the reference requirement per kind. `PROCESSED`, `REJECTED` and `FAILED` are terminal: a transition attempt throws `InvalidTransactionStateError` (a programming error, not a business path). Valid transitions are defined and documented. `OPENING` is internal and cannot be submitted through the API or the queue. The same idempotency key with a different payload is a conflict, not a replay. | 6.3 | MOD, IDE | T-U3, T-I1 |
| R-18 | `WalletLedgerEntry` has no mutable fields and no transition methods. `create` validates `balanceBefore +/- money == balanceAfter`. A financial transaction produces at most one entry per wallet. `LOSS` and any `REJECTED` transaction produce no entry. Double-entry bookkeeping is optional. | 6.4 | FIN, MOD | T-U2, T-I1 |
| R-19 | `InboxMessage` and `OutboxMessage` follow the reference skeleton. Inbox, financial change, ledger and outbox take part in the same SQL transaction. | 6.5 | MSG, MOD | T-I2 |
| R-20 | `BET` debits the balance with one `DEBIT` entry and is rejected when the balance is insufficient. | 7 | FIN | T-U4 |
| R-21 | `WIN` credits the balance with one `CREDIT` entry and may reference the `BET` of the same round. | 7 | FIN | T-U4 |
| R-22 | `LOSS` moves no balance, creates no entry and records the result as `PROCESSED`. | 7 | FIN | T-U4 |
| R-23 | `REFUND` credits the balance with one `CREDIT` entry and reverses a `PROCESSED` `BET` only once. | 7 | FIN | T-U4, T-I1 |
| R-24 | `ROLLBACK` applies the inverse direction of its reference with one inverted entry and reverses a `PROCESSED` `BET`, `WIN` or `REFUND` only once. | 7 | FIN | T-U4, T-I1 |
| R-25 | Reference rules: `REFUND` and `ROLLBACK` require `referenceExternalTransactionId`. The reference resolves by `(providerId, referenceExternalTransactionId)` and must belong to the same provider, player, wallet, currency and round. `REFUND` references only `BET`. `ROLLBACK` references `BET`, `WIN` or `REFUND`. A reference cannot be reversed twice by the same kind of operation (see OQ-07). The `REFUND`/`ROLLBACK` amount equals the reference amount (no partial reversal). | 7 rules 1-5 | FIN | T-U4 |
| R-26 | A `REJECTED` transaction changes no balance and creates no ledger entry. | 7 rule 6 | FIN | T-U4, T-I1 |
| R-27 | Repeating an operation already handled returns the original result, including the balance observed at that moment. | 7 rule 7 | IDE | T-I3, T-C1 |
| R-28 | A missing reference persists the transaction as `PENDING_REFERENCE` and it gets reprocessed later. | 7 rule 8 | MSG, FIN | T-C7 |
| R-29 | A reversal that would make the balance negative is explicitly `REJECTED` with a failure code distinct from a `BET` without funds, and stays auditable. | 7 rule 9 | FIN | T-U4 |
| R-30 | Every additional interpretation is documented. | 7 | DOC | Section 4, `ARCHITECTURE.md` |
| R-31 | `PENDING_REFERENCE` transactions are retried by a scheduled worker with exponential backoff and a chosen, justified attempt limit or TTL. When the limit is exhausted the transaction becomes `REJECTED` with a failure code that identifies the missing reference, and the matching event is published. | 7.1 | MSG | T-C7 |
| R-32 | Every rejection carries a stable, machine-readable `failureCode` that lets the provider decide to resend, fix the payload or give up. The taxonomy is defined and documented. | 7.2 | FIN, DOC | Design 3.12 |
| R-33 | The unit of concurrency is `walletId`. Correctness holds when two bets compete for the same balance, when several workers receive operations for the same wallet, when different wallets run in parallel, and with three or more instances. The strategy is justified in `ARCHITECTURE.md`. | 8 | CON | T-C2 to T-C4 |
| R-34 | Broker ordering and deduplication are optimizations only. The database stays responsible for the invariants. | 8 | CON, MSG | T-C1, T-C5 |
| R-35 | Mandatory scenario: initial balance `100.00 BRL`, two concurrent `80.00 BRL` bets. Exactly one is `PROCESSED`, the other is `REJECTED` for insufficient funds, the final balance is `20.00 BRL`, there is exactly one debit entry and no retry duplicates the debit. | 8 | CON, FIN | T-C2 |
| R-36 | `POST /wallets` follows the contract. An initial balance above zero creates an internal `OPENING` transaction with its `CREDIT` entry in the same SQL transaction. A duplicate wallet for the same `playerId` + `currency` fails as a conflict. | 9 | FIN | T-I7 |
| R-37 | Queries: `GET /wallets/:walletId`; `GET /wallets/:walletId/ledger?cursor=...&limit=50` with a stable, opaque cursor; `GET /wagering/transactions/:transactionId`; `GET /providers/:providerId/wagering/transactions/:externalTransactionId`. | 9 | FIN, MOD | T-I7 |
| R-38 | `POST /wagering/transactions` follows the request contract and answers `{ transactionId, status, balance, idempotentReplay }`. | 9 | IDE | T-I7 |
| R-39 | Idempotency: the `Idempotency-Key` header is mandatory and is the source of truth; recommended default `"{providerId}:{externalTransactionId}"`; `payloadHash` is the hash of a canonical JSON (sorted keys) of the business-field subset, excluding the header and transport metadata; the algorithm is documented; an identical request returns the same response with `idempotentReplay: true`; the same key with a different payload is a conflict and never a replay. | 9 | IDE | T-U5, T-I3, T-C1 |
| R-40 | The HTTP status mapping distinguishes, clearly and consistently across all endpoints: invalid payload, idempotency conflict, business rejection, accepted with pending processing, and transient infrastructure failure. | 9 | IDE, MSG | T-I7 |
| R-41 | `POST /wallets/:walletId/reconciliation` returns the contract shape. Divergences are logged, counted in a metric and flagged in the response, never silently corrected. | 9 | FIN, OBS | T-I8 |
| R-42 | `GET /health/live` (process alive) and `GET /health/ready` (PostgreSQL and SQS reachable) exist and require no authentication. | 9, 12 | OBS | T-I9 |
| R-43 | Authentication is the candidate's call and is worth 0 points. If not implemented: document the decision and the intended design in `ARCHITECTURE.md` and leave an explicit extension point in code (for example a no-op `AuthGuard` or a `ProviderIdentityPort`). Health endpoints stay open. Queue messages are a trusted internal channel, but the provider identity inside them still goes through domain validation. No home-made user table with password hashes. | 2 | DOC | OQ-01, S-04 |
| R-44 | Queues `wager-transactions.fifo` and `wager-transactions-dlq.fifo`. The message envelope is `{ messageId, type: "WagerTransactionRequested", occurredAt, data: { providerId, externalTransactionId, idempotencyKey, playerId, walletId, roundId, gameId, kind, money, referenceExternalTransactionId? } }`. | 10 | MSG | T-I4 |
| R-45 | The SQS consumer reuses the same use case as the HTTP entry point. | 10 | MOD, MSG | T-I3 (HTTP then SQS with the same key is a replay); review: the consumer calls `SubmitWagerTransaction` |
| R-46 | The consumer deduplicates through a persistent inbox keyed by `(consumerName, messageId)`. | 10 | IDE, MSG | T-I4 |
| R-47 | The consumer acknowledges (deletes) a message only after the commit. | 10 | MSG | T-C5 |
| R-48 | The consumer distinguishes business errors (terminal, ack), transient errors (retry with backoff) and permanent errors (DLQ). | 10 | MSG | T-I5 |
| R-49 | An attempt limit applies before the DLQ. | 10 | MSG | T-I5 |
| R-50 | On `SIGTERM` the consumer finishes in-flight messages or returns their visibility. | 10 | MSG | T-I6 |
| R-51 | Redelivery never duplicates effects. | 10 | IDE, MSG | T-I4, T-C5 |
| R-52 | Persisting the transaction, changing the balance, writing the ledger entry, recording the inbox row (SQS entry) and writing the integration event are atomic. | 11 | MSG, FIN | T-I2 |
| R-53 | An outbox worker publishes pending events and works with concurrent publishers without losing events or duplicating them indefinitely. | 11 | MSG | T-C6 |
| R-54 | Scenario: PostgreSQL commits; the process dies before publishing; another instance takes over; the event gets published; a duplicate publication stays safe for the consumer. | 11 | MSG | T-C6 |
| R-55 | Minimum events: `WagerTransactionProcessed` (any applied transaction, `LOSS` included), `WagerTransactionRejected` (business rejection), `WalletBalanceChanged` (only when the balance changes), `WagerTransactionPendingReference` (missing reference). | 11 | MSG | T-I2 (events per outcome), T-C7 |
| R-56 | The event envelope is an abstract class `IntegrationEvent<T>` with one concrete subclass per event. `eventType` and `version` live on the type. `toJSON()` returns `{ eventId, eventType, aggregateId, correlationId, causationId?, occurredAt (ISO-8601), version, data }`. `data` carries `MoneyProps`, never `Money`. | 11 | MOD, MSG | T-U6 |
| R-57 | Structured JSON logs carry `correlationId`, `messageId`, `transactionId`, `walletId`, `providerId` (when known). | 12 | OBS | T-I9 |
| R-58 | Logs contain no sensitive data and no full financial payloads. | 12 | OBS | T-I9 |
| R-59 | Metrics cover at least: transactions by status, duplicates detected, retries, DLQ messages, lock conflicts, outbox lag, processing latency. | 12 | OBS | T-I9 |
| R-60 | Liveness and readiness are separate health checks. | 12 | OBS | T-I9 |
| R-61 | Unit tests: `Money` operations and validations (scale, rounding, invalid inputs); `Wallet` invariants; `BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK` rules; currency conflict; idempotency key with a divergent payload. | 13 | TST | T-U1 to T-U6 |
| R-62 | Integration tests against real PostgreSQL and LocalStack/MiniStack containers: migrations and constraints; atomicity across wallet, ledger, inbox and outbox; inbox and redelivery; concurrent publishers on the same outbox; retry and DLQ; recovery after restart. | 13 | TST | T-I1 to T-I6, T-C6, T-C8 |
| R-63 | Concurrency tests with real parallelism, not sequential mocks: (1) the same bet sent 50 times in parallel gives one debit; (2) concurrent operations on one wallet's balance (section 8 scenario); (3) distinct wallets in parallel; (4) at least 3 processes or instances at once; (5) a worker killed after commit and before ack; (6) two publishers on the same outbox; (7) `ROLLBACK` or `REFUND` delivered before its reference; (8) a service restart with proof of final consistency. | 13 | TST, CON | T-C1 to T-C8 |
| R-64 | The final invariant of every test that touches wallets: `wallet.balance == balance rebuilt from the ledger`. | 13 | TST, FIN | `expectWalletConsistent` helper, section 3.21 |
| R-65 | `README.md` with setup and commands. `ARCHITECTURE.md` with decisions, trade-offs and limitations, including at least: ORM choice, `Money` mapping, transaction and concurrency strategy, authentication decision, transaction state machine, idempotency and payload-hash algorithm, failure-code taxonomy, HTTP mapping, `PENDING_REFERENCE` limit, every interpretation from section 4, and known limitations. | 2, 4, 7, 8, 14 | DOC | S-10 |

Optional differentials (challenge section 14), scheduled only if approved in OQ-06:

| ID | Differential | Notes |
|---|---|---|
| O-01 | Load test exposed as `bun run test:load`, reporting environment, methodology, throughput, p50/p95/p99, error rate, concurrency conflicts and outbox lag. | Honest analysis matters more than raw numbers. |
| O-02 | Double-entry ledger. | Not required. |
| O-03 | OpenTelemetry tracing or a dashboard. | Not required. |
| O-04 | Real IdP integration (Keycloak or Zitadel). | 0 points (OQ-01). |

### 2.3 Eliminatory failures as acceptance checks

Each check MUST pass before the delivery is considered complete. One failure disqualifies the delivery.

| ID | Eliminatory failure | Acceptance check |
|---|---|---|
| E-01 | `number` for money | `Money` stores a `bigint` of minor units. HTTP and SQS schemas accept `amount` only as a string matching the money regex, and a JSON number is a 400 (T-I7) or a DLQ move (T-I5). DB money columns are `numeric(20,2)`. The architecture test fails if `parseFloat`, `Number(` or `: number` appear in `src/domain/money` or in money-related schema fields. |
| E-02 | Negative balance caused by a race | `CHECK (balance >= 0)` on `wallets` and ledger columns, the wallet row lock (3.9), and T-C2 and T-C4 asserting the exact final balance. |
| E-03 | Duplicated debit or credit | Unique constraints (3.10), the inbox, idempotency, and T-C1, T-C5, T-I4 asserting exactly one ledger entry per transaction. |
| E-04 | Idempotency only in memory | All idempotency state lives in PostgreSQL. T-C8 restarts every instance between the original request and its replay and still gets `idempotentReplay: true`. |
| E-05 | Correct only with one instance | T-C4 runs 3 OS processes against the same database and queue. |
| E-06 | Event published before commit | Only the outbox publisher talks to the events queue, and it reads committed outbox rows only. The architecture test fails if `SendMessage`/`SendMessageBatch` appears outside `src/infrastructure/sqs/sqs-event-publisher.ts` (events queue) and `SqsQueueGateway.moveToDeadLetter` (DLQ only). T-I2 aborts a use case after the outbox insert and asserts nothing reaches the queue. |
| E-07 | No auditable ledger | Append-only `wallet_ledger_entries` (triggers forbid `UPDATE`, `DELETE`, `TRUNCATE`), the `GET /wallets/:walletId/ledger` endpoint and reconciliation. |
| E-08 | Tests that fully replace PostgreSQL and SQS with mocks | The integration and concurrency suites run against the Docker Compose PostgreSQL and MiniStack (or LocalStack) containers. No mock of `pg`, MikroORM or the SQS client exists in `test/integration` or `test/concurrency`. |

---

## 3. Design

### 3.1 Architecture and boundaries

Hexagonal (ports and adapters) inside a single deployable codebase (OQ-05):

- **Domain** (`src/domain`): entities, value objects, domain services and integration-event classes. Pure TypeScript. It knows nothing about HTTP, SQS, NestJS, MikroORM or PostgreSQL.
- **Application** (`src/application`): use cases and the ports they need (repositories, unit of work, event publisher, clock, id generator, metrics, logger). Plain classes without NestJS decorators. Wired by factory providers in Nest modules.
- **Driving adapters** (`src/interfaces`): HTTP controllers, the SQS consumer, and the two scheduled workers (outbox publisher, pending-reference retrier). They translate input into commands and call use cases.
- **Driven adapters** (`src/infrastructure`): MikroORM persistence, the SQS event publisher, logging, metrics, configuration.
- **Composition root** (`src/main.ts`, `src/app.module.ts`, `src/roles.ts`): builds the Nest application for the enabled process roles.

Process roles (`APP_ROLES`, comma-separated, default `api,consumer,outbox,pending-reference`): `api` serves HTTP; `consumer` polls `wager-transactions.fifo`; `outbox` publishes outbox rows; `pending-reference` retries `PENDING_REFERENCE` transactions. Every role is safe to run in any number of instances at the same time. `/health/*` and `/metrics` are served by every instance, whatever its roles.

Main flows, in words:

1. **HTTP submit**: controller validates the body and header, builds `SubmitWagerTransactionCommand`, calls `SubmitWagerTransaction` (3.8), maps the result or error to HTTP (3.13).
2. **SQS submit**: consumer receives a batch, validates each envelope, opens one SQL transaction per message that inserts the inbox row and calls the same `SubmitWagerTransaction` (it joins the transaction), commits, then deletes the message (3.14).
3. **Outbox publish**: the publisher claims due outbox rows with `FOR UPDATE SKIP LOCKED`, sends them to `wagering-events.fifo`, marks them published or schedules a retry, commits (3.15).
4. **Pending-reference retry**: the retrier picks due `PENDING_REFERENCE` transactions, locks their wallet, re-runs the same domain processing, persists the outcome and its events (3.16).

### 3.2 Module layout

| Path | Responsibility | May import |
|---|---|---|
| `src/domain/shared/` | `DomainError` base, `InvalidTransactionStateError`. | nothing |
| `src/domain/money/` | `Money`, `MoneyProps`, money errors. | `domain/shared` |
| `src/domain/wallet/` | `Wallet` aggregate, `WalletLedgerEntry`, `LedgerDirection`, wallet errors. | `domain/*` |
| `src/domain/wagering/` | `WagerTransaction`, `WagerTransactionKind`, `WagerTransactionStatus`, `FailureCode`, `ReferencePolicy`, `WagerTransactionProcessor` (pure domain service shared by submit and retry). | `domain/*` |
| `src/domain/messaging/` | `InboxMessage`, `OutboxMessage`, `RetrySchedule` (the single backoff policy: `min(base * 2^attempt, cap)` with plus or minus 20% jitter, used by SQS retries, the outbox and the pending-reference retrier). | `domain/*` |
| `src/domain/events/` | `IntegrationEvent<T>` and its four subclasses, `EventContext`. | `domain/*` |
| `src/application/ports/` | `WalletRepository`, `WagerTransactionRepository`, `LedgerRepository`, `InboxRepository`, `OutboxRepository`, `UnitOfWork`, `EventPublisher`, `Clock`, `IdGenerator`, `WageringMetrics`, `AppLogger`, `ProviderIdentityPort`. | `domain` |
| `src/application/wallets/` | `CreateWallet`, `GetWallet`, `ListWalletLedger`, `ReconcileWallet`. | `domain`, `application/ports` |
| `src/application/wagering/` | `SubmitWagerTransaction`, `GetWagerTransaction`, `RetryPendingReferences`, `PayloadHash` (canonical JSON + SHA-256). | `domain`, `application/ports`, `node:crypto` |
| `src/application/outbox/` | `PublishOutboxBatch`. | `domain`, `application/ports` |
| `src/application/errors.ts` | Application errors: `ValidationError`, `IdempotencyConflictError`, `ExternalTransactionConflictError`, `WalletNotFoundError`, `WalletAlreadyExistsError`, `TransactionNotFoundError`, `TransientInfrastructureError`. | `domain` |
| `src/infrastructure/persistence/` | MikroORM config, `records/` (EntitySchema persistence models), `mappers/` (record <-> domain via `rehydrate`), repositories, `MikroOrmUnitOfWork`, `pg-error-classifier.ts`, `migrations/`. | `application`, `domain`, `@mikro-orm/*` |
| `src/infrastructure/sqs/` | SQS client factory, `SqsEventPublisher` (implements `EventPublisher`), `SqsQueueGateway` (receive, delete, change visibility, move to DLQ). | `application`, `@aws-sdk/client-sqs` |
| `src/infrastructure/observability/` | pino logger with AsyncLocalStorage context, prom-client registry and `WageringMetrics` implementation, DLQ-depth and outbox-lag samplers. | `application`, `pino`, `prom-client` |
| `src/infrastructure/config/` | Zod schema for environment variables; fails fast on invalid config. | `zod` |
| `src/interfaces/http/` | Controllers, Zod request schemas, response presenters, `HttpErrorFilter` (error -> status), request-context middleware (correlation and request ids), `auth/` (`ProviderAuthGuard` no-op and the no-op `ProviderIdentityPort` adapter). | `application`, `domain`, `@nestjs/*`, `zod` |
| `src/interfaces/sqs/` | `WagerTransactionConsumer`, envelope schema, `MessageFailureClassifier`. | `application`, `domain`, `infrastructure/sqs` |
| `src/interfaces/workers/` | `OutboxPublisherWorker`, `PendingReferenceWorker` (poll loops with graceful stop). | `application` |
| `src/main.ts`, `src/app.module.ts`, `src/roles.ts` | Composition root and role selection. | everything |
| `scripts/` | `migrate.ts` (up/down via the MikroORM migrator), `setup-sqs.ts` (idempotent queue creation), `load-test.ts` (only if O-01). | `src`, SDKs |
| `test/unit`, `test/integration`, `test/concurrency`, `test/support` | Test tiers and shared helpers (section 3.21). | everything |

### 3.3 Technology choices

| Concern | Choice | Version line verified | Reason |
|---|---|---|---|
| Runtime, package manager, test runner | Bun | 1.4.4 | Mandatory. Runs NestJS decorators and MikroORM directly (Appendix A). |
| Language | TypeScript strict (`strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `experimentalDecorators`, `emitDecoratorMetadata`) | `tsc` 6.0.3 for `--noEmit` checks (7.0.2 also passes) | Bun transpiles at runtime. `tsc` only type-checks. Pin `typescript@~6.0`, the line the NestJS 12 CLI uses. |
| Framework | NestJS with the Express platform | 12.3.3 | Mandatory. Express verified under Bun. |
| ORM | MikroORM with `@mikro-orm/postgresql`, `@mikro-orm/nestjs`, `@mikro-orm/migrations` | 7.2.7 / nestjs 7.1.0 | Preferred by the challenge (OQ-03). |
| Database | PostgreSQL | 18.x (lab ran 18.6) | Mandatory. |
| Queue emulator | MiniStack (`ministackorg/ministack`) | 1.5.37 | No auth token needed (OQ-02). |
| AWS SDK | `@aws-sdk/client-sqs` | 3.x | Standard client. Endpoint configurable for LocalStack or MiniStack. |
| Validation | Zod schemas, used through NestJS 12 `StandardSchemaValidationPipe` and directly in the SQS consumer | zod 4.x | One schema language for HTTP and SQS input (OQ-18). |
| Logging | pino, JSON to stdout, no transports | 10.x | Structured and fast. A small Nest `LoggerService` adapter. |
| Metrics | prom-client, `GET /metrics` | 15.x | Standard Prometheus exposition. |
| Lint and format | Biome | 2.x | One fast tool (OQ-19). |
| IDs | UUIDv7 through the `IdGenerator` port (adapter uses `Bun.randomUUIDv7()`) | - | Time-ordered keys. The domain stays runtime-agnostic. |

### 3.4 ORM: MikroORM 7

Justification (for `ARCHITECTURE.md`): the challenge prefers it; it gives an explicit Unit of Work and Identity Map, `em.transactional()`, and `LockMode` values that map to the exact PostgreSQL locking clauses this design needs (`PESSIMISTIC_WRITE` gives `FOR UPDATE`, `PESSIMISTIC_PARTIAL_WRITE` gives `FOR UPDATE SKIP LOCKED`). All of it was verified under Bun (Appendix A).

Mapping approach:

- **Persistence records are separate from domain classes.** `src/infrastructure/persistence/records/*.record.ts` define plain record classes plus `EntitySchema` definitions (no decorators). Mappers convert records to domain objects through the domain `rehydrate` factories and back. This keeps the domain free of ORM types and honors the rule that rehydration goes through `rehydrate` (challenge 6.0).
- **Money columns** map with MikroORM `decimal` (string mode, the default in v7) to `numeric(20,2)` plus a `char(3)` currency column. The mapper builds `Money` from the string and currency. Nothing ever converts a money value to a JavaScript number, and SQL never casts money to `float`.
- **Migrations** are hand-written MikroORM migration classes with `up()` and `down()` using `this.addSql(...)` (raw SQL for constraints, partial indexes and triggers). They run through `scripts/migrate.ts` via `orm.migrator.up()` / `down()` with `transactional: true` and `allOrNothing: true`. The schema generator is not used for DDL.

Rules learned in the lab (MUST):

1. Repositories and the unit of work use the **context-resolved** `EntityManager` injected by `@mikro-orm/nestjs` (or the `em` passed into a `transactional` callback). Never call `transactional()` on a fork captured in a closure: the lab showed that a captured fork opens a *separate* database transaction inside an outer one, which silently breaks inbox/use-case atomicity. The context-resolved global `em` and the callback `em` both joined the outer transaction (same `txid_current()`).
2. Every non-HTTP unit of work (each SQS message, each worker tick) runs inside `RequestContext.create(orm.em, ...)`. `allowGlobalContext` stays `false`, so a missing context fails loudly.
3. `MikroOrmModule.forRoot` sets `driver: PostgreSqlDriver` explicitly. Without it, Nest cannot resolve the `EntityManager` from `@mikro-orm/postgresql` (seen in the lab).
4. Lock modes need an open transaction. MikroORM throws "An open transaction is required for this operation" otherwise, which is the desired safety net.
5. Trigger functions pin `search_path` (`SET search_path FROM CURRENT`), so they resolve tables no matter which `search_path` the ORM session uses. The lab hit `relation does not exist` from a deferred trigger before this was added.
6. Records declare `m:1` relations for their foreign keys (`transaction.wallet`, `ledgerEntry.wallet`, `ledgerEntry.transaction`), so the Unit of Work inserts parents first (as in the lab). The composite ledger foreign keys are also `DEFERRABLE INITIALLY DEFERRED`, so correctness never depends on flush order.

The `UnitOfWork` port: `run<T>(work: () => Promise<T>): Promise<T>`. `MikroOrmUnitOfWork` calls `em.transactional(work)` with the default `REQUIRED` propagation (an inner `run` joins an outer one). Isolation level is PostgreSQL's default `READ COMMITTED`, on purpose: after waiting on a row lock, `SELECT ... FOR UPDATE` returns the latest committed row and later statements see the committed effects of the transaction that held the lock. `REPEATABLE READ` would instead raise serialization failures on a hot wallet.

Timeouts (all from config, 3.19), so that "PostgreSQL temporarily unavailable" always ends in a fast, classified transient error and never in a hung request or a handler that outlives its SQS visibility:

- **Server-side, per session**, through the `pg` `options` connection parameter (MikroORM `driverOptions.options`): `lock_timeout` 2 s, `statement_timeout` 5 s, `transaction_timeout` 8 s (PostgreSQL 17+; terminates the session), `idle_in_transaction_session_timeout` 10 s. Lab: `transaction_timeout=800ms` with three 300 ms statements ended the transaction after about 920 ms.
- **Client-side**, through MikroORM `driverOptions` (passed to the `pg` pool): `connectionTimeoutMillis` 2 s, `query_timeout` 6 s (above `statement_timeout`, so a live server answers first), `keepAlive: true`. Lab, with every PostgreSQL process frozen by `SIGSTOP` (what `docker compose pause` does): a pooled query failed with `Query read timeout` after 1501 ms, a new connection failed with `timeout exceeded when trying to connect`, and the pool recovered after `SIGCONT`. Server-side timeouts cannot fire on a frozen server, so client-side timeouts are required.
- `pg-error-classifier.ts` maps these client errors (`Query read timeout`, `timeout exceeded when trying to connect`, `Connection terminated`, `Client has encountered a connection error`, `ECONNREFUSED`, `ECONNRESET`) and the SQLSTATEs listed in 3.8 to `TransientInfrastructureError`.

### 3.5 Money

- Internal representation: `bigint` count of minor units (cents) plus an ISO-4217 currency code. Scale is fixed at 2 for every currency, as the challenge mandates. No decimal library is needed for add/subtract/compare with a fixed scale (OQ-17).
- `Money.from({ amount, currency })` is the contract parser (HTTP and SQS input). `amount` MUST match `^(0|[1-9][0-9]{0,17})\.[0-9]{2}$` (non-negative, exactly two decimals, at most 18 integer digits like `numeric(20,2)`, no sign, no exponent, no whitespace, no leading zeros). `currency` MUST match `^[A-Z]{3}$`. Anything else throws `InvalidMoneyError`.
- `Money.rehydrate({ amount, currency })` rebuilds values read from the database or computed by SQL (for example the reconciliation sum). It accepts the same format plus an optional leading `-`, because a computed sum over an inconsistent ledger may be negative and reconciliation must still report it.
- Arithmetic (`add`, `subtract`, `negate`) may produce negative values (for example the reconciliation `difference`). `toJSON()` and `toString()` render `-5.00` style strings with exactly two decimals.
- `assertSameCurrency` throws `CurrencyMismatchError` for any binary operation across currencies.
- "Rounding" tests (R-61) assert that inputs with a third decimal (`"1.005"`) are rejected rather than rounded, and that no operation ever needs rounding.
- A credit that would push a balance past `numeric(20,2)` raises SQLSTATE `22003`, which is treated as a permanent error (HTTP 500, SQS DLQ). This is a documented limitation at about 10^18 units.
- BRL is the default currency in examples and fixtures. The model stays multi-currency and tests cover `USD` against a `BRL` wallet.

### 3.6 Domain model decisions

- `Wallet.open({ id, playerId, initialBalance, openingTransactionId, now })` returns the wallet (version 1) plus, when `initialBalance > 0`, the opening `WalletLedgerEntry` (`CREDIT`, `walletVersion` 1, `balanceBefore` 0). `CreateWallet` also creates the `OPENING` `WagerTransaction`, already `PROCESSED`: provider `_system` (the API's provider id format cannot start with `_`, and `wager_tx_opening_is_internal` reserves it), `externalTransactionId` = wallet id, idempotency key `wallet-opening:{walletId}`, round and game `wallet-opening`, and a payload hash computed with the 3.11 algorithm over these same fields.
- `Wallet.debit(money, transactionId, now): WalletLedgerEntry` and `Wallet.credit(...)`: check the currency, compute the new balance, throw `InsufficientFundsError` if it would go negative, increment `version` by exactly 1, and return the ledger entry stamped with the new `walletVersion`. Balance and ledger cannot diverge because the entry is the return value of the only methods that change the balance.
- `WalletLedgerEntry.create` validates `balanceBefore +/- money == balanceAfter`, positive `money`, the same currency everywhere and non-negative balances. It has only `readonly` fields.
- `WagerTransaction` keeps `observedBalance` (a `Money` in the wallet's currency, stored as `observed_balance` plus `observed_currency`) and `observedWalletVersion`: the wallet balance and version seen when it reached its current status. They are what an idempotent replay returns (R-27). A `CURRENCY_MISMATCH` row therefore still replays the balance in the wallet's currency.
- `WagerTransaction` stores `correlationId` so the pending-reference retrier can propagate it to the events and logs it produces later.
- `ReferencePolicy` (pure) answers whether a resolved reference is acceptable for a given transaction and, if not, with which `FailureCode` (order of checks in 3.8 step 9).
- `WagerTransactionProcessor` (pure domain service) takes the transaction, the locked wallet, the resolved reference (or none), whether the reference is already reversed, and `now`. It returns one of: `Applied { entry? }`, `Rejected { code }`, `AwaitingReference`. `SubmitWagerTransaction` and `RetryPendingReferences` both use it, so the rules exist once.
- Integration events: `WagerTransactionProcessed`, `WagerTransactionRejected`, `WalletBalanceChanged`, `WagerTransactionPendingReference`, each a subclass of `IntegrationEvent<T>` with `eventType` and `version = 1` declared on the class and a static `from(...)` factory. `OutboxMessage.enqueue(event)` stores `event.toJSON()` as `payload`, `event.eventId` as `id`.

Event data (all money as `MoneyProps`; `playerId` and full request payloads are left out on purpose):

| Event | aggregateId | data |
|---|---|---|
| `WagerTransactionProcessed` | transactionId | `transactionId, providerId, externalTransactionId, walletId, roundId, gameId, kind, money, referenceTransactionId?, balance, walletVersion, processedAt` |
| `WagerTransactionRejected` | transactionId | `transactionId, providerId, externalTransactionId, walletId, roundId, gameId, kind, money, referenceExternalTransactionId?, failureCode, balance` |
| `WalletBalanceChanged` | walletId | as in the challenge: `walletId, transactionId, direction, money, balanceBefore, balanceAfter, walletVersion` |
| `WagerTransactionPendingReference` | transactionId | `transactionId, providerId, externalTransactionId, walletId, kind, referenceExternalTransactionId, attempts, nextAttemptAt` |

Events per outcome: applied with balance change gives `WagerTransactionProcessed` + `WalletBalanceChanged`; applied `LOSS` gives `WagerTransactionProcessed`; `OPENING` gives both when the initial balance is above zero; rejected gives `WagerTransactionRejected`; awaiting reference gives `WagerTransactionPendingReference` (once, when it first enters the status); `FAILED` gives no event (logged and counted; see OQ-15). `correlationId` is the request or message correlation id; `causationId` is the SQS `messageId` or the HTTP `requestId` (3.13).

### 3.7 Transaction status state machine

| From | To | Trigger | Persisted? |
|---|---|---|---|
| (new) | `PENDING` | `WagerTransaction.create` | Never committed as `PENDING`: the same SQL transaction moves it on. |
| `PENDING` | `PROCESSED` | Rules pass and the balance effect (if any) is applied: `markProcessed(referenceTransactionId, at)`. | yes |
| `PENDING` | `REJECTED` | A business rule fails: `reject(code)`. | yes |
| `PENDING` | `PENDING_REFERENCE` | Reference missing, or present but itself `PENDING_REFERENCE`: `markPendingReference(schedule)`. | yes |
| `PENDING` | `FAILED` | Allowed by the model but not produced by the synchronous path: an infrastructure error aborts the SQL transaction, so nothing is persisted. | - |
| `PENDING_REFERENCE` | `PENDING_REFERENCE` | Retry found no usable reference: `scheduleReferenceRetry(now, policy)` increments `attempts` and moves `nextAttemptAt`. | yes |
| `PENDING_REFERENCE` | `PROCESSED` | Retry resolves the reference and the rules pass. | yes |
| `PENDING_REFERENCE` | `REJECTED` | Retry resolves the reference and a rule fails, or attempts are exhausted (`REFERENCE_NOT_FOUND`). | yes |
| `PENDING_REFERENCE` | `FAILED` | Retry hits a permanent non-business error on this transaction (for example a database integrity violation that signals a bug): `fail(PROCESSING_FAILED)`, persisted in a fresh SQL transaction. | yes |
| `PROCESSED`, `REJECTED`, `FAILED` | anything | Forbidden: the domain throws `InvalidTransactionStateError`; the database trigger raises `restrict_violation`. | - |

### 3.8 Processing algorithm (`SubmitWagerTransaction`)

Input: `SubmitWagerTransactionCommand` (the business fields plus `idempotencyKey`) and an `ExecutionContext` (`correlationId`, `causationId`, `source: "http" | "sqs"`).

1. **Contract validation** (adapter, Zod): shape, types, the field formats of 3.13, `Money.from`, `kind` not `OPENING`, reference present for `REFUND`/`ROLLBACK` and absent for `BET`. Failure: `ValidationError` (HTTP 400, SQS permanent). Nothing is persisted.
2. **Payload hash**: `PayloadHash.of(command)` (3.11).
3. **Fast idempotency path** (no lock): find by `(providerId, idempotencyKey)`. Found with an equal hash: return the stored result with `idempotentReplay: true`. Found with a different hash: `IdempotencyConflictError`.
4. **Open the unit of work** (joins the consumer's transaction when called from SQS). Session timeouts apply (3.4).
5. **Lock the wallet**: `SELECT ... FROM wallets WHERE id = $1 FOR UPDATE` (MikroORM `LockMode.PESSIMISTIC_WRITE`, `refresh: true`). Missing: `WalletNotFoundError` (HTTP 422, SQS permanent). The lock wait time is observed (3.18).
6. **Authoritative idempotency check** under the lock: repeat step 3's lookup (a concurrent identical request for the same wallet has committed by now). Then, if `(providerId, externalTransactionId)` already exists under a different key: `ExternalTransactionConflictError` (409).
7. **Create** the `WagerTransaction` (`PENDING`).
8. **Wallet scope**: `playerId` differs from the wallet's player gives `REJECTED PLAYER_WALLET_MISMATCH`; currency differs from the wallet's currency gives `REJECTED CURRENCY_MISMATCH`.
9. **Reference** (when `referenceExternalTransactionId` is set): resolve by `(providerId, referenceExternalTransactionId)`.
   - Not found: `PENDING_REFERENCE` (attempts 0, `nextAttemptAt = now + backoff(0)`).
   - Found, checks in this order: kind allowed (`REFUND -> BET`; `ROLLBACK -> BET | WIN | REFUND`; `WIN`/`LOSS -> BET`), else `REFERENCE_KIND_NOT_ALLOWED`; same player, wallet, currency and round, else `REFERENCE_SCOPE_MISMATCH`; reference status `PENDING_REFERENCE` gives `PENDING_REFERENCE` for this one too; `REJECTED` or `FAILED` gives `REFERENCE_NOT_PROCESSED`; for reversals, amount equal, else `REVERSAL_AMOUNT_MISMATCH`; for reversals, no `PROCESSED` reversal of that reference yet, else `REFERENCE_ALREADY_REVERSED`.
10. **Apply**: `BET` debits (`InsufficientFundsError` gives `INSUFFICIENT_FUNDS`); `WIN`, `REFUND` credit; `ROLLBACK` takes the opposite direction of the reference's ledger direction (`BET` debit gives credit; `WIN`/`REFUND` credit gives debit, and `InsufficientFundsError` gives `REVERSAL_INSUFFICIENT_FUNDS`); `LOSS` has no effect.
11. **Finish the transaction state**: `markProcessed`, `reject` or `markPendingReference`, always with `observedBalance` (wallet currency) and `observedWalletVersion`.
12. **Persist** in this unit of work: insert the transaction, insert the ledger entry (if any), update the wallet (if changed), insert outbox rows for the events of the outcome (3.6).
13. **Commit** and return `{ transaction, balance: observedBalance, idempotentReplay: false }`.

Race handling: a unique violation (`23505`) on `wager_tx_provider_idempotency_uq`, `wager_tx_provider_external_uq` or `wager_tx_single_reversal` aborts the SQL transaction. The owner of the outermost transaction retries the whole unit once, in a fresh `RequestContext` so no entity from the aborted attempt survives in the identity map: `SubmitWagerTransaction` itself on the HTTP path, the consumer's per-message handler (inbox insert included) on the SQS path. On the retry the fast path or step 9 returns the replay, conflict or `REFERENCE_ALREADY_REVERSED`. A second unique violation becomes `TransientInfrastructureError`. Each race increments `wagering_lock_conflicts_total{reason="unique_race"}`. `55P03` (lock timeout), `40P01`, `40001`, connection errors (`08*`, `57P01`-`57P03`), `57014` (statement timeout), `25P04` (transaction timeout), `53300` and the client-side timeouts of 3.4 become `TransientInfrastructureError`.

`CreateWallet` follows the same pattern: one unit of work inserts the wallet, the `OPENING` transaction, its ledger entry and the outbox rows; `23505` on `wallets_player_currency_uq` becomes `WalletAlreadyExistsError` (409).

### 3.9 Wallet concurrency strategy

**Pessimistic row lock per wallet**: every balance-changing transaction runs `SELECT ... FOR UPDATE` on exactly one `wallets` row inside the same SQL transaction that writes the transaction, the ledger entry, the wallet and the outbox rows (OQ-04).

- **Multiple instances**: the lock lives in PostgreSQL, so it serializes writers across any number of processes and hosts. There is no in-process or global lock (R-10, R-12).
- **Hot wallet**: concurrent writers queue on the row lock inside PostgreSQL and run one after another. Nothing is wasted on retries, and each waiter, once it has the lock, reads the fresh balance (`READ COMMITTED`). Throughput for one wallet is bounded by the duration of its critical section, which is kept short: no network I/O inside it (the event is an outbox insert), at most one wallet locked, about 5 statements. `lock_timeout` (default 2 s) turns pathological queues into a transient error (HTTP 503 or an SQS retry) instead of unbounded waits. On the SQS side, `MessageGroupId = walletId` keeps one in-flight message per wallet across all consumers, which cuts lock contention but is not relied on.
- **Deadlock freedom**: a transaction locks at most one wallet row. The pending-reference retrier locks the wallet first, then the transaction row, the same order as everyone else.
- **Different wallets**: independent row locks, full parallelism.
- **Defense in depth**: the `guard_wallet_update` trigger rejects any balance change whose version does not increment by exactly 1, `CHECK (balance >= 0)` rejects negatives, and the deferred `wallets_balance_change_requires_ledger_entry` constraint trigger rejects, at commit, a balance change without its ledger entry.

Lab evidence (Appendix A): 3 OS processes with MikroORM `PESSIMISTIC_WRITE` on PostgreSQL 18. The challenge scenario gave `["rejected","processed"]`, final `20.00`, 1 debit. The same key 50 times gave 1 processed and 49 replays. 60 distinct `10.00` bets on `100.00` gave exactly 10 processed, 50 rejected, final `0.00`, ledger consistent.

### 3.10 PostgreSQL schema

One initial migration creates everything below; `down()` drops the tables in reverse order (their triggers go with them), then the functions. Tables live in the default `public` schema. All money columns are `numeric(20,2)`, all timestamps `timestamptz`.

```sql
-- Generic guard for append-only tables.
CREATE FUNCTION forbid_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  RAISE EXCEPTION '% on % is forbidden: append-only table', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END $$;

CREATE TABLE wallets (
  id          uuid          PRIMARY KEY,
  player_id   uuid          NOT NULL,
  currency    char(3)       NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  balance     numeric(20,2) NOT NULL CHECK (balance >= 0),
  version     integer       NOT NULL CHECK (version >= 1),
  created_at  timestamptz   NOT NULL,
  updated_at  timestamptz   NOT NULL,
  CONSTRAINT wallets_player_currency_uq UNIQUE (player_id, currency),
  CONSTRAINT wallets_id_currency_uq UNIQUE (id, currency)  -- target of the ledger composite FK
);

CREATE FUNCTION guard_wallet_update() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.player_id <> OLD.player_id OR NEW.currency <> OLD.currency
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'wallet identity columns are immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.balance <> OLD.balance AND NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'a balance change must increment version by exactly 1' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.balance = OLD.balance AND NEW.version <> OLD.version THEN
    RAISE EXCEPTION 'version may change only together with the balance' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER wallets_guard_update BEFORE UPDATE ON wallets
  FOR EACH ROW EXECUTE FUNCTION guard_wallet_update();
CREATE TRIGGER wallets_forbid_delete BEFORE DELETE ON wallets
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE wager_transactions (
  id                                 uuid          PRIMARY KEY,
  provider_id                        varchar(64)   NOT NULL,
  external_transaction_id            varchar(128)  NOT NULL,
  idempotency_key                    varchar(255)  NOT NULL,
  payload_hash                       char(64)      NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  correlation_id                     varchar(128)  NOT NULL,
  wallet_id                          uuid          NOT NULL REFERENCES wallets (id),
  player_id                          uuid          NOT NULL,
  round_id                           varchar(128)  NOT NULL,
  game_id                            varchar(128)  NOT NULL,
  kind                               varchar(16)   NOT NULL
    CHECK (kind IN ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
  amount                             numeric(20,2) NOT NULL CHECK (amount >= 0),
  currency                           char(3)       NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  reference_external_transaction_id  varchar(128),
  reference_transaction_id           uuid          REFERENCES wager_transactions (id),
  status                             varchar(24)   NOT NULL
    CHECK (status IN ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
  failure_code                       varchar(64),
  observed_balance                   numeric(20,2) CHECK (observed_balance >= 0),
  observed_currency                  char(3)       CHECK (observed_currency ~ '^[A-Z]{3}$'),
  observed_wallet_version            integer       CHECK (observed_wallet_version >= 1),
  attempts                           integer       NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at                    timestamptz,
  created_at                         timestamptz   NOT NULL,
  updated_at                         timestamptz   NOT NULL,
  processed_at                       timestamptz,
  CONSTRAINT wager_tx_provider_idempotency_uq UNIQUE (provider_id, idempotency_key),
  CONSTRAINT wager_tx_provider_external_uq    UNIQUE (provider_id, external_transaction_id),
  CONSTRAINT wager_tx_ledger_target_uq        UNIQUE (id, wallet_id, amount, currency),  -- target of the ledger composite FK
  CONSTRAINT wager_tx_opening_is_internal     CHECK ((kind = 'OPENING') = (provider_id = '_system')),
  CONSTRAINT wager_tx_amount_positive_unless_loss CHECK (kind = 'LOSS' OR amount > 0),
  CONSTRAINT wager_tx_reference_required      CHECK (kind NOT IN ('REFUND','ROLLBACK') OR reference_external_transaction_id IS NOT NULL),
  CONSTRAINT wager_tx_reference_forbidden     CHECK (kind NOT IN ('OPENING','BET') OR reference_external_transaction_id IS NULL),
  CONSTRAINT wager_tx_resolved_reference_has_external CHECK (reference_transaction_id IS NULL OR reference_external_transaction_id IS NOT NULL),
  CONSTRAINT wager_tx_resolved_reference_when_processed CHECK (status <> 'PROCESSED' OR reference_external_transaction_id IS NULL OR reference_transaction_id IS NOT NULL),
  CONSTRAINT wager_tx_failure_code_iff_unsuccessful CHECK ((status IN ('REJECTED','FAILED')) = (failure_code IS NOT NULL)),
  CONSTRAINT wager_tx_processed_at_iff_processed CHECK ((status = 'PROCESSED') = (processed_at IS NOT NULL)),
  CONSTRAINT wager_tx_schedule_iff_pending_reference CHECK ((status = 'PENDING_REFERENCE') = (next_attempt_at IS NOT NULL)),
  CONSTRAINT wager_tx_observed_balance_when_settled CHECK (status = 'PENDING' OR
    (observed_balance IS NOT NULL AND observed_currency IS NOT NULL AND observed_wallet_version IS NOT NULL))
);
-- At most one OPENING per wallet.
CREATE UNIQUE INDEX wager_tx_one_opening_per_wallet ON wager_transactions (wallet_id) WHERE kind = 'OPENING';
-- A referenced transaction is reversed at most once (strict reading, OQ-07).
CREATE UNIQUE INDEX wager_tx_single_reversal ON wager_transactions (reference_transaction_id)
  WHERE kind IN ('REFUND','ROLLBACK') AND status = 'PROCESSED';
-- Pending-reference retrier queue.
CREATE INDEX wager_tx_pending_reference_due ON wager_transactions (next_attempt_at) WHERE status = 'PENDING_REFERENCE';
CREATE INDEX wager_tx_wallet_id ON wager_transactions (wallet_id);

CREATE FUNCTION guard_wager_transaction_update() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF OLD.status IN ('PROCESSED','REJECTED','FAILED') THEN
    RAISE EXCEPTION 'transaction % is terminal (%)', OLD.id, OLD.status USING ERRCODE = 'restrict_violation';
  END IF;
  IF NOT (OLD.status IN ('PENDING','PENDING_REFERENCE')
          AND NEW.status IN ('PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')) THEN
    RAISE EXCEPTION 'invalid transition % -> %', OLD.status, NEW.status USING ERRCODE = 'restrict_violation';
  END IF;
  IF (NEW.id, NEW.provider_id, NEW.external_transaction_id, NEW.idempotency_key, NEW.payload_hash,
      NEW.correlation_id, NEW.wallet_id, NEW.player_id, NEW.round_id, NEW.game_id, NEW.kind,
      NEW.amount, NEW.currency, NEW.reference_external_transaction_id, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.provider_id, OLD.external_transaction_id, OLD.idempotency_key, OLD.payload_hash,
      OLD.correlation_id, OLD.wallet_id, OLD.player_id, OLD.round_id, OLD.game_id, OLD.kind,
      OLD.amount, OLD.currency, OLD.reference_external_transaction_id, OLD.created_at) THEN
    RAISE EXCEPTION 'transaction request columns are immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER wager_tx_guard_update BEFORE UPDATE ON wager_transactions
  FOR EACH ROW EXECUTE FUNCTION guard_wager_transaction_update();
CREATE TRIGGER wager_tx_forbid_delete BEFORE DELETE ON wager_transactions
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER wager_tx_forbid_truncate BEFORE TRUNCATE ON wager_transactions
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

CREATE TABLE wallet_ledger_entries (
  id              uuid          PRIMARY KEY,
  wallet_id       uuid          NOT NULL,
  transaction_id  uuid          NOT NULL,
  wallet_version  integer       NOT NULL CHECK (wallet_version >= 1),
  direction       varchar(6)    NOT NULL CHECK (direction IN ('DEBIT','CREDIT')),
  amount          numeric(20,2) NOT NULL CHECK (amount > 0),
  currency        char(3)       NOT NULL,
  balance_before  numeric(20,2) NOT NULL CHECK (balance_before >= 0),
  balance_after   numeric(20,2) NOT NULL CHECK (balance_after >= 0),
  created_at      timestamptz   NOT NULL,
  -- The entry moves exactly its transaction's amount, in its wallet's currency.
  -- Deferred to COMMIT so correctness never depends on the ORM's flush order.
  CONSTRAINT ledger_wallet_currency_fk FOREIGN KEY (wallet_id, currency) REFERENCES wallets (id, currency)
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT ledger_transaction_fk FOREIGN KEY (transaction_id, wallet_id, amount, currency)
    REFERENCES wager_transactions (id, wallet_id, amount, currency) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT ledger_one_entry_per_transaction_wallet UNIQUE (transaction_id, wallet_id),
  -- One entry per balance version: also the stable cursor key for pagination.
  CONSTRAINT ledger_wallet_version_uq UNIQUE (wallet_id, wallet_version),
  CONSTRAINT ledger_balanced CHECK (
    (direction = 'CREDIT' AND balance_after = balance_before + amount) OR
    (direction = 'DEBIT'  AND balance_after = balance_before - amount))
);
CREATE TRIGGER ledger_forbid_update_delete BEFORE UPDATE OR DELETE ON wallet_ledger_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER ledger_forbid_truncate BEFORE TRUNCATE ON wallet_ledger_entries
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- Checked at COMMIT: every balance change (and a positive opening balance) has the ledger entry
-- that moves exactly from the old balance to the new one at the new version.
CREATE FUNCTION assert_balance_change_has_ledger_entry() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE
  expected_before numeric(20,2);
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.balance = 0 THEN RETURN NULL; END IF;
    expected_before := 0;
  ELSE
    IF NEW.version = OLD.version THEN RETURN NULL; END IF;
    expected_before := OLD.balance;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM wallet_ledger_entries e
                 WHERE e.wallet_id = NEW.id AND e.wallet_version = NEW.version
                   AND e.balance_before = expected_before AND e.balance_after = NEW.balance) THEN
    RAISE EXCEPTION 'wallet % version % has no matching ledger entry', NEW.id, NEW.version
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER wallets_balance_change_requires_ledger_entry
  AFTER INSERT OR UPDATE ON wallets DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_balance_change_has_ledger_entry();

-- Checked at COMMIT (the vice-versa): a ledger entry is never ahead of its wallet,
-- so an entry cannot be written without the matching balance change.
CREATE FUNCTION assert_ledger_entry_applied_to_wallet() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM wallets w WHERE w.id = NEW.wallet_id AND w.version >= NEW.wallet_version) THEN
    RAISE EXCEPTION 'ledger entry % is ahead of wallet %', NEW.id, NEW.wallet_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER ledger_entry_requires_wallet_change
  AFTER INSERT ON wallet_ledger_entries DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_ledger_entry_applied_to_wallet();

CREATE TABLE inbox_messages (
  consumer_name  varchar(64)  NOT NULL,
  message_id     varchar(128) NOT NULL,
  payload_hash   char(64)     NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  received_at    timestamptz  NOT NULL,
  processed_at   timestamptz,
  PRIMARY KEY (consumer_name, message_id)
);

CREATE TABLE outbox_messages (
  id               uuid         PRIMARY KEY,           -- = eventId
  aggregate_id     uuid         NOT NULL,
  event_type       varchar(64)  NOT NULL,
  payload          jsonb        NOT NULL,              -- IntegrationEvent.toJSON()
  occurred_at      timestamptz  NOT NULL,
  attempts         integer      NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at  timestamptz  NOT NULL,              -- = occurred_at when enqueued
  published_at     timestamptz,
  last_error       varchar(512)
);
CREATE INDEX outbox_messages_due ON outbox_messages (next_attempt_at) WHERE published_at IS NULL;
```

What each guarantee rests on:

| Guarantee | Enforced by |
|---|---|
| One wallet per player and currency | `wallets_player_currency_uq` |
| Non-negative balances | `CHECK (balance >= 0)`, ledger `balance_before`/`balance_after` checks, `observed_balance` check |
| Replays report the balance in the wallet's currency | `observed_currency`, `wager_tx_observed_balance_when_settled` |
| Version increments by 1 only with balance changes | `guard_wallet_update` |
| Every balance change has its exact ledger entry, and vice versa | `wallets_balance_change_requires_ledger_entry` and `ledger_entry_requires_wallet_change` (deferred), `ledger_wallet_version_uq`. Residual gap: a bogus entry at version 1 of a wallet opened at zero passes both; reconciliation (sum and chain check) detects it. |
| Entry arithmetic | `ledger_balanced`, `amount > 0` |
| Entry matches its transaction and wallet currency | `ledger_transaction_fk`, `ledger_wallet_currency_fk` |
| At most one entry per transaction per wallet | `ledger_one_entry_per_transaction_wallet` |
| Ledger immutability | `ledger_forbid_update_delete`, `ledger_forbid_truncate` |
| Idempotency and external id uniqueness | `wager_tx_provider_idempotency_uq`, `wager_tx_provider_external_uq` |
| Single reversal per reference | `wager_tx_single_reversal` |
| One opening per wallet; `OPENING` internal only | `wager_tx_one_opening_per_wallet`, `wager_tx_opening_is_internal` |
| Terminal states and request columns immutable; valid transitions only | `guard_wager_transaction_update`, delete/truncate triggers |
| Status-dependent columns coherent | the `wager_tx_*_iff_*` and `*_when_*` checks |
| Inbox dedup | primary key `(consumer_name, message_id)` |

Error codes the application maps: `23505` unique, `23514` check, `23503` foreign key, `23001` (`restrict_violation`, raised by the guard triggers), `23000` (deferred ledger checks), `22001` (string too long; impossible after validation, whose lengths match the column widths) and `22003` (numeric overflow). Outside the documented `23505` races, any of these during processing signals a bug or an overflow: HTTP 500, SQS permanent, and `FAILED` in the retrier.

Retention (documented limitation, not built): `inbox_messages` rows older than the SQS maximum retention (14 days) and published `outbox_messages` rows can be purged by a later job. The ledger and transactions are never purged.

### 3.11 Idempotency and payload hash

- **Key**: HTTP header `Idempotency-Key` (SQS: `data.idempotencyKey`), required, 1 to 255 visible ASCII characters (`^[\x21-\x7E]{1,255}$`). Recommended value `"{providerId}:{externalTransactionId}"`; not enforced. Uniqueness scope is the provider: `(provider_id, idempotency_key)` (OQ-13).
- **Hashed subset** (exactly these fields): `providerId`, `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`, `money.amount`, `money.currency`, `referenceExternalTransactionId` (only when present). Excluded: the idempotency key, `messageId`, `type`, `occurredAt`, headers, correlation ids and any unknown field (unknown fields are stripped by validation).
- **Normalization before hashing**: UUID fields lowercased; `money.amount` already canonical because of the strict format; an absent or `null` `referenceExternalTransactionId` is omitted; every other string is used verbatim (no trimming, no case folding).
- **Canonical JSON**: objects serialize with keys sorted by UTF-16 code unit order (JavaScript default sort) at every level; no insignificant whitespace; strings and keys escaped exactly as `JSON.stringify` does; no `undefined` members.
- **Hash**: lowercase hex SHA-256 of the UTF-8 bytes of the canonical JSON (`node:crypto` `createHash("sha256")`).
- **Test vector** (the challenge's example request):
  - canonical JSON: `{"externalTransactionId":"transaction-123","gameId":"fortune-chimp","kind":"BET","money":{"amount":"25.00","currency":"BRL"},"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","providerId":"provider-a","roundId":"round-987","walletId":"0192f291-27dd-7d3f-8071-5f8685deef37"}`
  - SHA-256: `629836932b79106b99523d06a1e7fa80689b0ea1e1c47aa3f0a5a2c87d0c4344` (computed with Bun and checked with `sha256sum`)
- **Decision**: stored hash equal gives a replay of the stored result (status, failure code, `observedBalance`) with `idempotentReplay: true` and the status code of the stored status (3.13). Stored hash different gives `IDEMPOTENCY_KEY_CONFLICT`. Because HTTP and SQS build the same command, a request sent over HTTP and replayed over SQS with the same key is a replay.
- A replay of a transaction still in `PENDING_REFERENCE` returns its current state (202); once settled, the replay returns the settled result.
- Idempotency state is only the `wager_transactions` row. There is no separate response cache (R-06).

### 3.12 Failure-code taxonomy

Persisted on `REJECTED` transactions. Every rejection is final for its `(providerId, externalTransactionId)`: resending it returns the stored result (same key) or `EXTERNAL_TRANSACTION_CONFLICT` (new key). "Fix and resend" therefore always means a new operation with a new `externalTransactionId` and a new idempotency key.

| Code | Meaning | Provider decision |
|---|---|---|
| `INSUFFICIENT_FUNDS` | `BET` amount exceeds the balance. | Give up, or later a new operation. |
| `REVERSAL_INSUFFICIENT_FUNDS` | A `ROLLBACK` of a `WIN` or `REFUND` would make the balance negative (R-29). | Give up; operational follow-up (distinct from a bet without funds). |
| `CURRENCY_MISMATCH` | `money.currency` differs from the wallet currency. | Fix: new operation with the right currency. |
| `PLAYER_WALLET_MISMATCH` | `playerId` does not own `walletId`. The response omits `balance` (another player's data). | Fix: new operation with the right wallet. |
| `REFERENCE_NOT_FOUND` | The reference never appeared within the retry window (3.16). | Investigate; new operation once the reference exists. |
| `REFERENCE_KIND_NOT_ALLOWED` | The reference kind is not allowed (`REFUND` of a non-`BET`, `ROLLBACK` of a `LOSS`/`ROLLBACK`/`OPENING`, `WIN`/`LOSS` referencing a non-`BET`). | Fix: new operation with the right reference. |
| `REFERENCE_SCOPE_MISMATCH` | The reference belongs to another player, wallet, currency or round. | Fix: new operation with the right reference. |
| `REFERENCE_NOT_PROCESSED` | The reference is `REJECTED` or `FAILED`, or it still was not `PROCESSED` when the retry window ran out. | Give up. |
| `REFERENCE_ALREADY_REVERSED` | The reference already has a `PROCESSED` `REFUND` or `ROLLBACK`. | Give up (already done). |
| `REVERSAL_AMOUNT_MISMATCH` | The reversal amount differs from the reference amount. | Fix: new operation with the reference amount. |

Persisted on `FAILED` transactions: `PROCESSING_FAILED`, a permanent non-business error while retrying a `PENDING_REFERENCE` transaction. Auditable through `GET /wagering/transactions/:id`.

Request error codes (HTTP body `code`; never persisted as a transaction):

| Code | HTTP | Meaning |
|---|---|---|
| `VALIDATION_FAILED` | 400 | Malformed body, header, path or query (includes invalid `Money`, `OPENING` submitted, missing or forbidden reference, bad cursor). `details` lists field errors. |
| `IDEMPOTENCY_KEY_CONFLICT` | 409 | Same key, different payload hash. |
| `EXTERNAL_TRANSACTION_CONFLICT` | 409 | `(providerId, externalTransactionId)` already exists under another key. |
| `WALLET_ALREADY_EXISTS` | 409 | Wallet for `playerId` + `currency` exists; `details.walletId` gives the existing id. |
| `WALLET_NOT_FOUND` | 404 (path) / 422 (body reference) | See the rule in 3.13. |
| `TRANSACTION_NOT_FOUND` | 404 | Unknown transaction id or external id. |
| `UNAUTHENTICATED` / `FORBIDDEN` | 401 / 403 | Reserved for the auth extension point (OQ-01). |
| `SERVICE_UNAVAILABLE` | 503 + `Retry-After` | Transient infrastructure failure (DB or SQS unreachable, lock timeout, deadlock, serialization). Safe to retry with the same key. |
| `INTERNAL_ERROR` | 500 | Unexpected. Nothing was committed or the result is idempotent; retry with the same key. |

### 3.13 HTTP API and status mapping

Consistency rules (apply to every endpoint):

- `400` = the request itself is malformed. Fix it.
- `404` = the resource named by the URL path does not exist.
- `409` = conflict with existing state (idempotency, external id, duplicate wallet). Do not retry as is.
- `422` = business rejection, including a body that references a wallet that does not exist. Do not retry as is.
- `202` = accepted, processing pending (`PENDING_REFERENCE`).
- `503` = transient infrastructure failure. Retry with the same idempotency key, after `Retry-After`.
- `500` = unexpected error. Retry with the same key.
- `2xx` bodies are resources. Every non-2xx body has a machine-readable `code`: errors are `{ "code": "...", "message": "...", "details"?: ... }`, and a `422` from transaction processing is the transaction result (below) with `code` equal to its `failureCode`, so the provider also sees `transactionId`, `status` and `balance`.
- The status code of a transaction outcome is a pure function of the transaction's current status, so an identical request always gets the same response, as the challenge requires: `PROCESSED` 201, `PENDING_REFERENCE` 202, `REJECTED` and `FAILED` 422. Only `idempotentReplay` differs between the first response and its replays.

| Endpoint | Success | Errors |
|---|---|---|
| `POST /wallets` | `201` `{ id, playerId, balance, version }` | 400, 409 `WALLET_ALREADY_EXISTS`, 503 |
| `GET /wallets/:walletId` | `200` `{ id, playerId, balance, version }` | 400 (not a UUID), 404, 503 |
| `GET /wallets/:walletId/ledger?cursor&limit` | `200` `{ items: [{ id, transactionId, direction, money, balanceBefore, balanceAfter, walletVersion, createdAt }], nextCursor }` | 400 (bad cursor or limit), 404, 503 |
| `GET /wagering/transactions/:transactionId` | `200` transaction view | 400, 404, 503 |
| `GET /providers/:providerId/wagering/transactions/:externalTransactionId` | `200` transaction view | 400, 404, 503 |
| `POST /wagering/transactions` | `201` `PROCESSED`; `202` `PENDING_REFERENCE`; `422` `REJECTED` or `FAILED` (first response and replays alike) | 400, 409 `IDEMPOTENCY_KEY_CONFLICT` / `EXTERNAL_TRANSACTION_CONFLICT`, 422 `WALLET_NOT_FOUND`, 503, 500 |
| `POST /wallets/:walletId/reconciliation` | `200` contract shape (`consistent: false` is still 200) | 400, 404, 503 |
| `GET /health/live` | `200` `{ status: "ok" }` | - |
| `GET /health/ready` | `200` `{ status: "ok", checks: { postgres, sqs } }` | `503` with the failing check; also `503` once shutdown starts |
| `GET /metrics` | `200` Prometheus text | - |

Transaction result body (201/202/422 from `POST /wagering/transactions`): `{ transactionId, status, balance, idempotentReplay, failureCode?, code? }`, where `balance` is the `observedBalance` (omitted for `PLAYER_WALLET_MISMATCH`) and `code` repeats `failureCode` on 422. The transaction view adds `providerId, externalTransactionId, walletId, playerId, roundId, gameId, kind, money, referenceExternalTransactionId?, referenceTransactionId?, createdAt, processedAt?`.

Ledger pagination: newest first (`ORDER BY wallet_version DESC`). `nextCursor` is base64url of `{"v":<lastWalletVersion>}`; the next page uses `wallet_version < v`. It is stable because the ledger is append-only and versions are unique per wallet. `limit` defaults to 50, max 200. Clients treat the cursor as opaque; a cursor that fails to decode is a 400.

Reconciliation: one SQL statement (one consistent snapshot under `READ COMMITTED`) reads the stored balance, `COALESCE(SUM(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END), 0)::numeric(20,2)` and `COUNT(*)` from the ledger, plus a chain check (each entry's `balance_before` equals the previous entry's `balance_after`, through a window function). Values are parsed with `Money.rehydrate`. `difference = stored - calculated`. On a divergence: `warn` log `reconciliation.divergence` (with `walletId`, no amounts) and `wagering_reconciliation_divergences_total` increments. Nothing is corrected.

Headers: `X-Correlation-Id` is accepted if it matches `^[A-Za-z0-9._:-]{1,128}$`, otherwise generated (UUIDv7). Every request also gets a generated `requestId` (UUIDv7), used as the `causationId` of the events it produces. Both are echoed (`X-Correlation-Id`, `X-Request-Id`) and logged. `Retry-After: 1` on 503.

Input field formats (HTTP and SQS share them; lengths match the column widths, so `22001` cannot happen after validation):

| Field | Format |
|---|---|
| `providerId` | `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$` (cannot start with `_`, which keeps `_system` internal) |
| `externalTransactionId`, `referenceExternalTransactionId`, `roundId`, `gameId` | `^[\x21-\x7E]{1,128}$` (visible ASCII) |
| `playerId`, `walletId`, path ids | UUID (any version), normalized to lowercase |
| `kind` | `BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK` |
| `money` | `{ amount, currency }` per 3.5 (`Money.from`) |
| `Idempotency-Key` / `data.idempotencyKey` | `^[\x21-\x7E]{1,255}$` |
| SQS `messageId` | `^[\x21-\x7E]{1,128}$` |

Authentication extension point (OQ-01 recommended path): a global `ProviderAuthGuard` that allows everything, applied to every route except `/health/*` and `/metrics`, and the application port `ProviderIdentityPort`, whose no-op adapter returns "anonymous". The intended real design (documented, not built): each provider is an OIDC client of Keycloak or Zitadel using client credentials; the guard validates the JWT against the IdP's JWKS; the use case asserts the token's `provider_id` claim equals `command.providerId` (`403 FORBIDDEN`). SQS messages skip the guard (trusted channel) but `providerId` still goes through format validation and every lookup is scoped by it.

### 3.14 SQS consumer

Queues (created idempotently by `scripts/setup-sqs.ts`): `wager-transactions-dlq.fifo`; `wager-transactions.fifo` with `VisibilityTimeout=30`, `RedrivePolicy={ deadLetterTargetArn: <dlq arn>, maxReceiveCount: 5 }`; `wagering-events.fifo` for outbox events (OQ-16). Producers of `WagerTransactionRequested` SHOULD use `MessageGroupId = walletId` and `MessageDeduplicationId = messageId`. The consumer never relies on either: concurrency tests send with a random `MessageGroupId` per message precisely so that SQS cannot serialize a wallet's messages (R-07).

Loop (role `consumer`): long-poll `ReceiveMessage` (`WaitTimeSeconds=20`, `MaxNumberOfMessages=10`, system attributes `ApproximateReceiveCount`, `MessageGroupId`), with an `AbortSignal` for shutdown. Group the batch by `MessageGroupId`: groups run in parallel up to `SQS_HANDLER_CONCURRENCY`; messages within a group run sequentially in batch order. A failed message does not stop the rest of its group: order is only an optimization, and skipping would inflate the receive counts of messages never attempted. Before starting a message, if more than half of `SQS_VISIBILITY_TIMEOUT_S` has elapsed since it was received, the consumer extends its visibility back to the full timeout (`ChangeMessageVisibility`), so later messages of a batch never become visible to another instance while still queued here.

Per message, inside `RequestContext.create`:

1. Parse JSON and validate the envelope with Zod (`type` must be `WagerTransactionRequested`). The inbox `payloadHash` is the SHA-256 of the canonical JSON of the envelope's `data` object (3.11 canonicalization). Transport fields such as `occurredAt` are left out, so a producer that re-stamps them on a retry is still a duplicate.
2. Open the unit of work. Insert the inbox row with `INSERT ... ON CONFLICT (consumer_name, message_id) DO NOTHING` (MikroORM `qb.insert(...).onConflict([...]).ignore()`; verified). Zero rows inserted: read the existing row. Same hash gives `duplicate` (commit, ack, `wagering_duplicates_total{type="inbox"}`). Different hash gives a permanent error (`INBOX_PAYLOAD_MISMATCH`).
3. Call `SubmitWagerTransaction` (joins the unit of work). Set `processed_at` on the inbox row. Commit.
4. Only after the commit returns: `DeleteMessage`. If the delete fails, the message comes back, step 2 sees the inbox row, and it gets acked then.

Error classification:

| Class | Cases | Action |
|---|---|---|
| Business, terminal | `PROCESSED`, `REJECTED`, `PENDING_REFERENCE`, idempotent replay, inbox duplicate, `IDEMPOTENCY_KEY_CONFLICT`, `EXTERNAL_TRANSACTION_CONFLICT` | Outcomes and replays commit (transaction rows and/or the inbox row), then `DeleteMessage`. Conflicts throw, so the unit of work rolls back (no inbox row; a redelivery conflicts again) and the message is deleted; they are logged (`warn`) and counted. |
| Transient | `TransientInfrastructureError` (PostgreSQL unreachable, frozen or restarting, client or server timeouts, lock timeout, deadlock, serialization, too many connections), SQS throttling or network errors, and any unclassified error | No delete. `ChangeMessageVisibility` to the `RetrySchedule` delay for attempt `receiveCount - 1`, rounded up to whole seconds (about 2, 4, 8, 16 s by default). After `maxReceiveCount` = 5 receives, the SQS redrive policy moves the message to the DLQ. `wagering_retries_total{component="sqs"}`. |
| Permanent | Invalid JSON or envelope, unsupported `type`, `OPENING` kind, `ValidationError`, `WalletNotFoundError`, `INBOX_PAYLOAD_MISMATCH`, integrity violations that signal a bug | Send the same body to `wager-transactions-dlq.fifo` (same `MessageGroupId`, `MessageDeduplicationId = messageId`, message attributes `failureReason` and `failureCode`), then `DeleteMessage`. A crash between the two only causes a duplicate DLQ copy, which DLQ dedup absorbs. `wagering_dlq_messages_total{reason}`. |

FIFO queues reject per-message `DelaySeconds` (verified on MiniStack), so backoff uses the visibility timeout. A message waiting out its backoff blocks its group, which keeps the per-wallet order for the retry. The visibility timeout (30 s) stays above the worst-case handler time: `transaction_timeout` (8 s) bounds each attempt, and the one unique-race retry makes it 16 s at most.

Unknown errors count as transient on purpose: a wrong "permanent" guess would send a recoverable message to the DLQ early, while a wrong "transient" guess costs only 4 retries before the redrive policy sends it there anyway.

### 3.15 Transactional outbox

Write side: every use case that produces events inserts their `outbox_messages` rows in its own unit of work (R-52). Nothing else sends events.

Publisher (role `outbox`), per tick inside a new transaction:

1. `SELECT ... FROM outbox_messages WHERE published_at IS NULL AND next_attempt_at <= now() ORDER BY occurred_at, id LIMIT OUTBOX_BATCH_SIZE FOR UPDATE SKIP LOCKED` (MikroORM `LockMode.PESSIMISTIC_PARTIAL_WRITE`; verified SQL).
2. `SendMessageBatch` to `wagering-events.fifo`: body = `payload`, `MessageGroupId = aggregate_id`, `MessageDeduplicationId = id` (the eventId), message attributes `eventType`, `version`, `correlationId`. The SDK call has a 5 s timeout.
3. Successful entries: `published_at = now()`, `attempts = attempts + 1`. Failed entries: `attempts = attempts + 1`, `next_attempt_at = now() + RetrySchedule delay` (base `OUTBOX_RETRY_BASE_MS`, cap `OUTBOX_RETRY_MAX_MS`, defaults 1 s and 5 min), `last_error` (truncated, no payload). Rows never give up: losing an event is forbidden, and the lag metric raises the alarm.
4. Commit. Poll again at once if the batch was full, otherwise after `OUTBOX_POLL_INTERVAL_MS`.

Why it works with concurrent publishers: `SKIP LOCKED` hands disjoint row sets to concurrent publishers (lab: 3 publishers, 300 rows, every row published exactly once). The row locks are held during the send, so a crashed publisher's transaction aborts and its rows are immediately claimable by another instance. No lease column is needed.

Duplicates are bounded and safe: a crash after the send and before the commit republishes that batch once. Within 5 minutes FIFO deduplication drops it, and after that consumers deduplicate by `eventId` (the envelope's stable id; documented consumer contract). There is no ordering guarantee across aggregates or across publishers. `WalletBalanceChanged.walletVersion` lets consumers order balance events.

Holding a transaction open during an SQS call (at most 5 s) is a deliberate KISS trade-off over a lease column. It only locks outbox rows, which nothing else updates.

### 3.16 Pending-reference retrier

Role `pending-reference`, every `PENDING_REFERENCE_POLL_INTERVAL_MS`:

1. Candidates: `SELECT id, wallet_id FROM wager_transactions WHERE status = 'PENDING_REFERENCE' AND next_attempt_at <= now() ORDER BY next_attempt_at LIMIT 20` (no lock).
2. Per candidate, in its own unit of work and request context: lock the wallet with a plain `FOR UPDATE` bounded by `lock_timeout` (a hot wallet is waited for, not skipped, so its pending references cannot starve; a lock timeout leaves the row for the next tick); reload the transaction and re-check it is still `PENDING_REFERENCE` and due (another instance may have handled it); resolve the reference; run `WagerTransactionProcessor` (the same rules as submit).
3. Outcomes: `Applied` or `Rejected` persist the outcome and its events. `AwaitingReference` increments `attempts` (the number of completed retries). If `attempts` is now `PENDING_REFERENCE_MAX_ATTEMPTS`, the transaction becomes `REJECTED` with `WagerTransactionRejected`: `REFERENCE_NOT_FOUND` if the reference never appeared, `REFERENCE_NOT_PROCESSED` if it exists but is still pending. Otherwise `next_attempt_at = now + RetrySchedule delay` (base `PENDING_REFERENCE_RETRY_BASE_MS`, cap `PENDING_REFERENCE_RETRY_MAX_MS`). On entry into `PENDING_REFERENCE` (3.8 step 9) `attempts` is 0 and the first delay is `BASE`.
4. Errors on one candidate never stop the tick. A transient error leaves the row untouched for the next tick (`wagering_retries_total{component="pending_reference"}`). A permanent non-business error (integrity violation, invariant breach) rolls back, and a fresh SQL transaction locks the wallet again and marks the transaction `FAILED PROCESSING_FAILED` only if it is still `PENDING_REFERENCE` (logged at `error`, counted), because retrying cannot fix it.

Chosen limit (OQ-09, decided): about a 1-hour window. `PENDING_REFERENCE_MAX_ATTEMPTS` 20, base 1 s, cap 300 s. Delays before each retry (attempt 0 to 19): 1, 2, 4, 8, 16, 32, 64, 128, 256 s, then eleven times 300 s, for a total of 511 + 3300 = 3811 s (about 63.5 minutes, plus or minus jitter). Justification: out-of-order delivery between a bet and its reversal usually resolves in seconds (parallel consumption, SQS redelivery), but provider-side incidents and replays can take much longer; one hour gives operations room to recover before a definitive `REFERENCE_NOT_FOUND`, while the 5-minute cap keeps the retry load negligible. All values are configurable, and tests use milliseconds.

Latency note: a reversal that arrives first waits for the next scheduled retry after its reference lands (at most the current backoff step). Eager wake-up of dependents is a possible later optimization, not built (KISS).

### 3.17 Graceful shutdown (SIGTERM)

`app.enableShutdownHooks()` (verified: `onApplicationShutdown` received `SIGTERM` under Bun). Order:

1. Readiness flips to 503 at once.
2. The consumer stops polling and aborts the in-flight long poll through its `AbortSignal` (verified: `AbortError` within about 300 ms).
3. Messages received but not started get `ChangeMessageVisibility(0)` (immediately available to other instances).
4. In-flight handlers get up to `SHUTDOWN_GRACE_MS` (default 20 s) to commit and ack. Any still running at the deadline get `ChangeMessageVisibility(0)`. If their transaction commits afterwards, the redelivered copy is an inbox duplicate.
5. The outbox publisher and the pending-reference retrier finish their current tick and stop.
6. `app.close()` drains HTTP connections and closes the ORM pool.

Docker Compose sets `stop_grace_period: 30s` (the Docker default of 10 s is shorter than the grace period).

### 3.18 Observability

Logging: pino JSON lines to stdout, one logger, with an AsyncLocalStorage context set by the HTTP middleware, the consumer (per message) and the workers (per unit). Every line carries `correlationId`, and `messageId`, `transactionId`, `walletId`, `providerId` whenever known, plus `level`, `time`, `msg`, `event` (stable `snake.case` name such as `transaction.processed`), `role` and `instanceId`.

Never logged: amounts, balances, `playerId`, request or message bodies, idempotency keys, headers other than the correlation id, SQS receipt handles. A pino `redact` list backs this up, and T-I9 asserts it on captured output.

Key log events: `transaction.processed`, `transaction.rejected` (`failureCode`), `transaction.pending_reference`, `idempotency.replay`, `idempotency.conflict`, `inbox.duplicate`, `sqs.retry_scheduled` (`receiveCount`, `delaySeconds`), `sqs.moved_to_dlq` (`reason`), `outbox.published` (count), `outbox.publish_failed`, `lock.timeout`, `reconciliation.divergence`, `shutdown.started`, `shutdown.completed`.

Metrics (prom-client, `GET /metrics`, default process metrics on):

| Metric | Type | Labels | Covers |
|---|---|---|---|
| `wagering_transactions_total` | counter | `kind`, `status`, `source` | transactions by status |
| `wagering_duplicates_total` | counter | `type` = `inbox`, `idempotent_replay` | duplicates detected |
| `wagering_idempotency_conflicts_total` | counter | `source`, `code` | conflicting payloads |
| `wagering_retries_total` | counter | `component` = `sqs`, `outbox`, `pending_reference`, `unique_race` | retries |
| `wagering_dlq_messages_total` | counter | `reason` | messages this service moved to the DLQ |
| `wagering_dlq_depth` | gauge | `queue` | DLQ size from `ApproximateNumberOfMessages`, sampled every 30 s (also counts redrive moves) |
| `wagering_wallet_lock_wait_seconds` | histogram | - | time to acquire the wallet row lock |
| `wagering_lock_conflicts_total` | counter | `reason` = `contended` (wait above `LOCK_CONTENTION_THRESHOLD_MS`, default 10 ms), `timeout`, `unique_race` | lock conflicts |
| `wagering_outbox_lag_seconds` | gauge | - | age of the oldest unpublished outbox row, sampled each publisher tick |
| `wagering_processing_duration_seconds` | histogram | `source`, `kind`, `outcome` | processing latency |
| `wagering_reconciliation_divergences_total` | counter | - | reconciliation divergences (R-41) |

Deadlock and serialization failures are still classified as transient (3.8), but they get no metric label: with `READ COMMITTED` and one wallet lock per transaction they are not expected, and an unexpected one shows up in the logs.

Health: `/health/live` never touches dependencies. `/health/ready` runs `SELECT 1` (1 s timeout) and `GetQueueAttributes` on `wager-transactions.fifo` (1 s timeout) in parallel.

### 3.19 Configuration

Validated with Zod at boot. Invalid configuration exits non-zero with a readable message.

| Variable | Default | Notes |
|---|---|---|
| `APP_ROLES` | `api,consumer,outbox,pending-reference` | Process roles (3.1). |
| `PORT` | `3000` | HTTP port. |
| `INSTANCE_ID` | hostname | Logged on every line. |
| `DATABASE_URL` | - | PostgreSQL connection string. |
| `DB_POOL_MAX` | `10` | Per instance; 3 instances x 10 stays below PostgreSQL's 100 connections. |
| `DB_LOCK_TIMEOUT_MS` | `2000` | Session `lock_timeout` (3.4). |
| `DB_STATEMENT_TIMEOUT_MS` | `5000` | Session `statement_timeout`. |
| `DB_TRANSACTION_TIMEOUT_MS` | `8000` | Session `transaction_timeout` (PostgreSQL 17+). |
| `DB_IDLE_IN_TRANSACTION_TIMEOUT_MS` | `10000` | Session `idle_in_transaction_session_timeout`. |
| `DB_CONNECT_TIMEOUT_MS`, `DB_QUERY_TIMEOUT_MS` | `2000`, `6000` | Client-side `connectionTimeoutMillis` and `query_timeout`. |
| `LOCK_CONTENTION_THRESHOLD_MS` | `10` | Lock wait counted as `contended`. |
| `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | `us-east-1`, `test`, `test` | Emulator credentials. |
| `SQS_ENDPOINT` | `http://localhost:4566` | MiniStack or LocalStack. |
| `SQS_WAGER_QUEUE_NAME`, `SQS_WAGER_DLQ_NAME`, `SQS_EVENTS_QUEUE_NAME` | `wager-transactions.fifo`, `wager-transactions-dlq.fifo`, `wagering-events.fifo` | Tests override with unique names. |
| `SQS_MAX_RECEIVE_COUNT` | `5` | Used by `setup-sqs.ts` for the redrive policy. |
| `SQS_VISIBILITY_TIMEOUT_S` | `30` | Queue attribute. |
| `SQS_WAIT_TIME_S`, `SQS_BATCH_SIZE`, `SQS_HANDLER_CONCURRENCY` | `20`, `10`, `10` | Consumer loop. |
| `SQS_RETRY_BASE_S`, `SQS_RETRY_MAX_S` | `2`, `60` | Transient backoff. |
| `OUTBOX_POLL_INTERVAL_MS`, `OUTBOX_BATCH_SIZE` | `500`, `10` | Publisher. |
| `OUTBOX_RETRY_BASE_MS`, `OUTBOX_RETRY_MAX_MS` | `1000`, `300000` | Publisher backoff. |
| `PENDING_REFERENCE_POLL_INTERVAL_MS` | `1000` | Retrier. |
| `PENDING_REFERENCE_MAX_ATTEMPTS`, `PENDING_REFERENCE_RETRY_BASE_MS`, `PENDING_REFERENCE_RETRY_MAX_MS` | `20`, `1000`, `300000` | OQ-09 (about 63.5 minutes in total). |
| `SHUTDOWN_GRACE_MS` | `20000` | 3.17. |
| `LOG_LEVEL` | `info` | pino level. |

### 3.20 Local environment (Docker Compose)

Services in `docker-compose.yml`:

| Service | Image | Purpose |
|---|---|---|
| `postgres` | `postgres:18-alpine` (pinned minor) | Database. Healthcheck `pg_isready`. An init script also creates `wagering_test`. |
| `sqs` | `ministackorg/ministack:<pinned tag>` with `SERVICES=sqs` | SQS emulator on 4566. Healthcheck `GET /_ministack/health` (it also answers `/_localstack/health`). |
| `setup` | the app image | One-shot: `bun run db:migrate && bun run sqs:setup`. Idempotent. |
| `app-1`, `app-2`, `app-3` | the app image (`oven/bun:1.4` base), from one YAML anchor | Three instances with all roles, host ports 3001 to 3003, `stop_grace_period: 30s`, `depends_on: setup (service_completed_successfully)`. |

Three explicit services (instead of `--scale`) give deterministic ports and let a demo kill one instance by name (`docker compose kill app-2`). Switching to LocalStack only changes the `sqs` service and `SQS_ENDPOINT`. LocalStack 2026.03+ needs `LOCALSTACK_AUTH_TOKEN` (OQ-02).

Scripts in `package.json`: `dev`, `start`, `typecheck`, `lint`, `format`, `check`, `db:migrate`, `db:rollback`, `sqs:setup`, `test:unit`, `test:integration`, `test:concurrency`, `test` (all tiers), and `test:load` (only if O-01).

### 3.21 Test strategy

Tiers (all `bun test`; `bunfig.toml` sets the preload and timeouts):

| Tier | Path | Dependencies | Runs |
|---|---|---|---|
| Unit | `test/unit` | none | In parallel (`bun test --parallel test/unit`), under 10 s. |
| Integration | `test/integration` | Compose `postgres` + `sqs` | Serially (Bun's default; no `--parallel`). The app runs in-process through `Test.createTestingModule` (real adapters) or as spawned processes where a crash or restart is needed. |
| Concurrency | `test/concurrency` | Compose `postgres` + `sqs`; spawns app processes from source | Serially, 60 s per-test timeout. |

Rules:

- **Real infrastructure**: integration and concurrency tests use the real PostgreSQL and MiniStack (or LocalStack). No mocks for `pg`, MikroORM or the SQS client there (E-08). Unit tests may use in-memory fakes of ports.
- **Isolation without cleanup**: every test creates its own wallets, players and provider ids (UUIDv7), and every test file uses its own uniquely named queues (`setup-sqs` with a run-id suffix). Nothing is truncated (the ledger forbids it). Migrations run once in the preload against `wagering_test`.
- **Determinism**: no fixed sleeps for synchronization. An `eventually(assertion, { timeoutMs })` helper polls observable state. Races start from a shared barrier (all workers wait for a start timestamp or a resolved promise). Retry delays are shrunk through configuration (milliseconds).
- **Final invariant** (R-64): `expectWalletConsistent(walletId)` runs in `afterEach` for every wallet the test touched. It checks `wallets.balance = SUM(ledger)`; ledger versions contiguous up to `wallets.version`, starting at 1 for a wallet opened with a balance and at 2 for one opened at zero; each `balance_before` equal to the previous `balance_after`; and the ledger entry count equal to the number of `PROCESSED` balance-affecting transactions of the wallet.
- **Multiple instances**: `test/support/instances.ts` spawns N processes with `Bun.spawn(["bun", "src/main.ts"], { env })` on distinct ports, waits for `/health/ready`, spreads requests round-robin, and offers `kill(signal)` and `restart()`. The lab verified that 3 Bun processes racing on PostgreSQL row locks behave as designed.
- **Fault injection without production hooks**: crash scenarios use test entrypoints in `test/support/entrypoints/` that build the real application with `Test.createTestingModule({ imports: [AppModule] })` and override one provider, for example the `SqsQueueGateway.delete` used for ack, or the `EventPublisher`, with a wrapper that calls `process.kill(process.pid, "SIGKILL")` at the chosen point. Production code has no test switches.
- **PostgreSQL outage**: `docker compose pause postgres` / `unpause` from the test (transient path and recovery). A paused server never answers, so these tests depend on the client-side timeouts of 3.4.
- **Real races through SQS**: SQS variants of concurrency tests send each message with a random `MessageGroupId` and distinct `MessageDeduplicationId`/`messageId`, and assert `wagering_lock_conflicts_total{reason="contended"} > 0` summed over the instances, which proves the database, not the broker, serialized them.

Test catalogue:

| ID | Test (file) | Covers |
|---|---|---|
| T-U1 | `test/unit/domain/money.test.ts`: `Money.from` parsing (valid, every invalid class: `NaN`, `Infinity`, `1e3`, `""`, `"1.005"`, `"1"`, `"-1.00"`, `"01.00"`, `" 1.00"`, 19 integer digits, lowercase currency, JSON number), `Money.rehydrate` accepting a negative computed value, immutability, add/subtract/negate/compare, currency mismatch error, no rounding, serialization of negatives. | R-15, R-61, E-01 |
| T-U2 | `wallet.test.ts`, `wallet-ledger-entry.test.ts`: open with and without balance, debit/credit, insufficient funds, version rules, currency mismatch, entry arithmetic validation, `rehydrate` skips validation. | R-16, R-18 |
| T-U3 | `wager-transaction.test.ts`: create per kind (reference required or forbidden, `OPENING` rejected), every valid transition, every terminal transition throws `InvalidTransactionStateError`, `matchesPayload`, `affectsBalance`, `requiresReference`, `ledgerDirectionFor`. | R-17 |
| T-U4 | `wager-transaction-processor.test.ts`: `BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK` rules, every failure code of 3.12 in the check order of 3.8, rollback direction per reference kind, `REVERSAL_INSUFFICIENT_FUNDS` versus `INSUFFICIENT_FUNDS`, currency conflict. | R-20 to R-26, R-29 |
| T-U5 | `payload-hash.test.ts`: the test vector, key-order independence, UUID case normalization, excluded fields do not change the hash, any business field does; plus the idempotency decision (same key and divergent payload gives a conflict). | R-39, R-61 |
| T-U6 | `integration-events.test.ts`: each subclass's `eventType`/`version`, `toJSON` shape, `MoneyProps` in `data`. | R-56 |
| T-U7 | `architecture.test.ts`: the dependency rule (P-1.2) and the E-01/E-06 static checks. | P-1.2, E-01, E-06 |
| T-I1 | `test/integration/persistence/schema.test.ts`: migrations up, down, up; every constraint, index and trigger of 3.10 rejects its violation with the expected SQLSTATE (append-only ledger, non-negativity, version guard, both deferred ledger checks including an entry with the wrong `balance_before` and an entry without a balance change, single reversal, opening uniqueness, terminal guard, composite FKs, and a ledger row inserted before its transaction in the same SQL transaction still commits). | R-03, R-09, R-13, R-16 to R-18 |
| T-I2 | `wagering/atomicity.test.ts`: with an outbox adapter that throws after inserting, `SubmitWagerTransaction` and `CreateWallet` leave no wallet, transaction, ledger, wallet change, inbox or outbox row, and (from S-06) no event reaches the queue; the happy path writes all of them in one commit; outbox rows per outcome are exactly those of 3.6 (applied `BET`: Processed + BalanceChanged; `LOSS`: Processed only; `OPENING` above zero: both; rejected: Rejected; pending: PendingReference; replay: none). The inbox part runs from S-05. | R-08, R-19, R-52, R-55, E-06 |
| T-I3 | `wagering/idempotency.test.ts`: replay returns the original result and observed balance after the balance moved; conflict on a divergent payload; HTTP then SQS with the same key is a replay. | R-27, R-39 |
| T-I4 | `messaging/inbox-redelivery.test.ts`: the same message delivered twice (two sends with different dedup ids and the same `messageId`) gives one effect and two acks; `ChangeMessageVisibility(0)` redelivery gives one effect. | R-46, R-51 |
| T-I5 | `messaging/retry-and-dlq.test.ts`: transient (PostgreSQL paused) messages are retried with growing visibility and succeed after unpause; with PostgreSQL kept down they reach the DLQ after 5 receives; permanent (malformed, unknown wallet) go to the DLQ on the first receive with `failureReason`; business rejection is acked with a `REJECTED` row and `WagerTransactionRejected` in the outbox. | R-48, R-49 |
| T-I6 | `messaging/graceful-shutdown.test.ts`: SIGTERM during processing finishes the in-flight message (committed and acked) and returns unstarted messages to the queue at once. | R-50 |
| T-I7 | `http/*.test.ts`: every row of the 3.13 table, including 201/200/202/422 for submit, `Idempotency-Key` missing gives 400, JSON number money gives 400, duplicate wallet gives 409 with `walletId`, cursor pagination stability across appends, unknown body wallet gives 422. | R-36 to R-40 |
| T-I8 | `wallets/reconciliation.test.ts`: consistent wallet; a divergence induced by the test (superuser `ALTER TABLE wallets DISABLE TRIGGER ALL`, a direct balance update, then `ENABLE TRIGGER ALL`) gives `consistent: false`, the metric increments and the log line appears; a second reconciliation still reports the same divergence (nothing was corrected); the test then restores the balance the same way, so the final invariant holds. | R-41 |
| T-I9 | `observability/observability.test.ts`: captured log lines are JSON with the required fields, and contain no amounts, balances, `playerId` or bodies; `/metrics` exposes every metric of 3.18 and they move under a scenario; `/health/live` and `/health/ready` (503 with PostgreSQL paused). | R-42, R-57 to R-60 |
| T-C1 | `test/concurrency/same-bet-50x.test.ts`: the same bet (same key) 50 times in parallel across 3 instances over HTTP and, separately, 50 SQS messages with distinct `messageId`s, dedup ids and random groups; exactly one debit, the rest replays. | R-63(1), R-07, E-03 |
| T-C2 | `mandatory-scenario.test.ts`: 100.00 BRL, two 80.00 bets at once from two instances (HTTP) and through SQS (random groups); one `PROCESSED`, one `REJECTED INSUFFICIENT_FUNDS`, 20.00, one debit; re-sending both changes nothing. | R-35, R-63(2), E-02 |
| T-C3 | `distinct-wallets.test.ts`: 20 wallets x 20 operations in parallel with per-wallet expected balances; then 20 wallets x 1 operation in parallel, asserting `wagering_lock_conflicts_total{reason="contended"}` did not move (no operation waited for another wallet's lock, so there is no shared lock). | R-63(3), R-10 |
| T-C4 | `multi-instance.test.ts`: 3 processes with all roles, mixed HTTP and SQS load (bets, wins, losses, refunds, rollbacks, duplicates) on hot and cold wallets; at the end every wallet is consistent, events published, queues empty. | R-63(4), R-12, E-05 |
| T-C5 | `crash-after-commit-before-ack.test.ts`: consumer entrypoint that SIGKILLs itself after commit and before `DeleteMessage`; the DB shows one effect and the message is still queued; a normal instance receives it after the visibility timeout, detects the inbox duplicate and acks; one debit, empty queue and DLQ. | R-63(5), R-47 |
| T-C6 | `outbox-publishers.test.ts`: 500 outbox rows and 3 publisher processes: every row published, each eventId received, no duplicates without crashes; then a publisher entrypoint that SIGKILLs after `SendMessageBatch` and before commit: another instance republishes, and any duplicate carries the same `eventId`. | R-53, R-54, R-63(6) |
| T-C7 | `reference-before-arrival.test.ts`: `REFUND` and `ROLLBACK` sent before their `BET`/`WIN` (HTTP 202, `WagerTransactionPendingReference`), the reference arrives, the retrier settles them; a second scenario with tiny limits ends in `REJECTED REFERENCE_NOT_FOUND` plus its event. | R-28, R-31, R-63(7) |
| T-C8 | `restart-consistency.test.ts`: under load, SIGKILL all 3 instances, restart them, wait for queues, outbox and due pending references to drain; every wallet consistent, every committed transaction has its events published, replays after the restart still return `idempotentReplay: true`. | R-63(8), R-62, E-04 |

---

## 4. Open questions

Each item is a decision the challenge leaves to the candidate or leaves ambiguous. All of them were decided on 2026-11-06; the **Decided** line under each item is binding for implementation. Items OQ-01 to OQ-06 shape scope and stack. Items OQ-07 to OQ-23 are interpretations.

### Scope and stack decisions

**OQ-01 Authentication.** Options: (a) documented no-op `ProviderAuthGuard` plus `ProviderIdentityPort` extension point, with the intended Keycloak/Zitadel client-credentials design written in `ARCHITECTURE.md`; (b) real IdP (Keycloak or Zitadel in Compose, JWT validation, provider claim check). Recommendation: (a). Impact: auth is worth 0 points and the challenge accepts (a) explicitly; (b) costs roughly half a day (realm bootstrap, token fetching in every HTTP test, compose startup time) taken from scored areas. Slice affected: S-04.

**Decided:** (a), the documented no-op guard plus `ProviderIdentityPort`.

**OQ-02 SQS emulator: LocalStack or MiniStack.** Facts checked: since LocalStack for AWS 2026.03.0 (March 23, 2026) an auth token is required to start it; the free option is a Hobby plan for non-commercial use that needs an account; the temporary bypass ended April 6, 2026. MiniStack is MIT-licensed, needs no token, listens on 4566 and answers LocalStack's health path; version 1.5.37 passed every FIFO check this design needs (Appendix A). Options: (a) MiniStack as the default and the only one in CI and tests; (b) LocalStack (every evaluator needs a token); (c) MiniStack by default plus a documented LocalStack override (`SQS_ENDPOINT` and a compose profile). Recommendation: (c), where only MiniStack is tested. Impact: evaluators can run `docker compose up` without creating any account; the challenge names both as acceptable.

**Decided:** (c), MiniStack by default and in tests, with a documented LocalStack override.

**OQ-03 ORM: MikroORM or TypeORM.** Recommendation: MikroORM 7. Reasons: preferred by the challenge; explicit Unit of Work, `transactional()` and `LockMode` including `SKIP LOCKED`; verified under Bun with NestJS 12. Impact: TypeORM would also work but adds nothing here, and the evaluation explicitly favors MikroORM. Risk: the nested-transaction pitfall (3.4 rule 1), mitigated by the rule and by T-I2.

**Decided:** MikroORM 7.

**OQ-04 Locking: pessimistic, optimistic or conditional update.** Options: (a) pessimistic `SELECT ... FOR UPDATE` per wallet; (b) optimistic `UPDATE ... WHERE version = $v` with bounded retries; (c) atomic conditional update `UPDATE wallets SET balance = balance - $a ... WHERE id = $id AND balance >= $a RETURNING ...`; (d) PostgreSQL advisory lock per wallet. Recommendation: (a). Impact: (a) handles the hot wallet best (waiters queue in PostgreSQL, no retry storms), keeps the rules in the domain (the wallet aggregate decides), needs no retry loop, and is deadlock-free with one wallet per transaction. (b) degrades badly under contention, needs retry budgets that can still fail, and turns the 50x test into many conflicts. (c) is fast but moves the balance rule into SQL, and still needs the row lock it implicitly takes for the idempotency and reversal checks. (d) adds a second locking mechanism next to row locks. `version` is still kept and guarded by the database.

**Decided:** (a), pessimistic row lock per wallet.

**OQ-05 Separate services or one deployable with process roles.** Options: (a) one codebase and one image; every instance runs all roles (API, SQS consumer, outbox publisher, pending-reference retrier), and Compose runs 3 instances; (b) the same single image, deployed per role (for example 3 API, 3 consumers, 2 publishers, 2 retriers) by setting `APP_ROLES`; (c) separate services (for example wallet API, ingestion consumer, event publisher) in separate codebases or packages. Recommendation: (a) for the delivery, with (b) documented as the production deployment option, since it is the same artifact with a different environment variable. Impact: (a) and (b) keep the challenge's hard requirement that inbox, financial change, ledger and outbox commit in one SQL transaction on one database, and (a) exercises every concurrency path (multiple consumers, publishers and retriers) with just 3 instances. (c) would split one transactional boundary across services that still share one database (an anti-pattern) or would need distributed transactions; it multiplies build, compose and test work and earns no points.

**Decided:** (a), one codebase and one image, all roles in every instance, 3 instances in Compose.

**OQ-06 Optional differentials.** Candidates: (a) load test `bun run test:load` (O-01); (b) double-entry ledger (O-02); (c) OpenTelemetry or dashboards (O-03); (d) OpenAPI via `@nestjs/swagger` with pt-BR descriptions. Recommendation: none are scheduled. If S-01 to S-10 finish with time left, do (a) as a Bun script reusing the instance harness against the 3 Compose instances (the challenge values it and it reuses T-C4 tooling), then (d) if time remains. Skip (b) (a model change with high regression risk) and (c). Impact: keeps the 3-day budget on the 100 scored points.

**Decided:** no differentials scheduled for now.

### Interpretations with defaults

**OQ-07 Reversal uniqueness.** The challenge rule 4 says a reference cannot be reversed twice "by the same kind of operation", which literally allows one `REFUND` and one `ROLLBACK` of the same `BET` (crediting it twice). Options: (a) literal: unique `(reference_transaction_id, kind)` among processed reversals; (b) strict: at most one processed reversal of any kind per reference. Recommendation: (b), which satisfies rule 4 and prevents a double credit; a `ROLLBACK` of a `REFUND` is still possible because it references the `REFUND`. Impact: changes one partial index and the `REFERENCE_ALREADY_REVERSED` check.

**Decided:** (b), strict: at most one processed reversal per referenced transaction.

**OQ-08 Money input format.** Options: (a) strict, exactly two decimals (`"25.00"`); (b) lenient, 0 to 2 decimals normalized (`"25"` becomes `"25.00"`). Recommendation: (a): the challenge says amounts are received with a fixed scale of 2, and strictness makes the payload hash unambiguous. Impact: providers sending `"25"` get 400.

**Decided:** (a), strict two decimals.

**OQ-09 Pending-reference limit.** Options: (a) 10 attempts, exponential from 1 s capped at 60 s (about 5 minutes); (b) about a 1-hour window with the backoff capped at 5 minutes; (c) a long TTL such as 24 hours. Impact: how long a provider waits for a definitive `REFERENCE_NOT_FOUND`.

**Decided:** about a 1-hour window: 20 attempts, base 1 s, cap 300 s (3.16), configurable.

**OQ-10 HTTP codes for outcomes.** Recommendation: the code is a function of the transaction status, identical for the first response and every replay ("mesma resposta"): `PROCESSED` 201, `PENDING_REFERENCE` 202, `REJECTED` and `FAILED` 422 with the transaction result body (with `code`); conflicts 409; transient 503 with `Retry-After`. Alternatives: 200 for replays (distinguishes them by status code, but the challenge asks for the same response); `FAILED` as 500 with the transaction body (semantically "server failure", but it would invite retries of a terminal outcome); 200 for every settled outcome with the status only in the body (the challenge discourages making providers parse bodies). Impact: the provider integration contract.

**Decided:** as recommended.

**OQ-11 Unknown wallet in a submission.** The transaction cannot be persisted (foreign key), so it cannot be idempotently recorded. Recommendation: HTTP 422 `WALLET_NOT_FOUND` (body reference rule), SQS permanent error (DLQ) for operator follow-up. Alternative: SQS ack plus log only (loses the message). Impact: DLQ volume if providers send unknown wallets.

**Decided:** as recommended.

**OQ-12 Language of `ARCHITECTURE.md`.** `README.md` is pt-BR by principle P-2. `ARCHITECTURE.md` is read by the evaluation panel, who wrote the challenge in pt-BR, but it is technical. Options: pt-BR or English. Recommendation: pt-BR, treating the panel as the stakeholder audience, with code identifiers kept in English. Impact: S-10 only.

**Decided:** pt-BR.

**OQ-13 Idempotency key scope.** Options: unique per provider `(provider_id, idempotency_key)` or global. Recommendation: per provider, so one provider's key can never collide with another's. Impact: one unique constraint.

**Decided:** per provider.

**OQ-14 `WIN`/`LOSS` references and zero amounts.** Recommendation: `WIN` and `LOSS` may carry an optional reference that must resolve to a `PROCESSED` `BET` of the same scope (missing gives `PENDING_REFERENCE`); `BET` must not carry a reference; `LOSS` may have amount `0.00`; every other kind needs a positive amount (a `WIN` of zero is a validation error; providers send `LOSS` instead). Impact: validation rules and two CHECK constraints.

**Decided:** as recommended.

**OQ-15 When `FAILED` is used.** Recommendation: only for a `PENDING_REFERENCE` transaction whose retry hits a permanent non-business error (3.16). On the synchronous path an infrastructure error aborts the SQL transaction, so nothing is persisted and the caller retries (HTTP 503/500, SQS retry or DLQ). No integration event for `FAILED` (not in the minimum list), only log and metric. Impact: auditability of rare internal failures.

**Decided:** as recommended.

**OQ-16 Events destination.** Options: SQS FIFO queue `wagering-events.fifo` or an SNS FIFO topic. Recommendation: SQS FIFO queue (fewer moving parts, testable on MiniStack, dedup by `eventId`). Impact: consumers of events; switching later only changes `SqsEventPublisher`.

**Decided:** SQS FIFO queue `wagering-events.fifo`.

**OQ-17 Money internals.** Options: `bigint` minor units or `decimal.js`. Recommendation: `bigint` (exact, no dependency, no global precision setting; `decimal.js` precision is in significant digits and defaults to 20, which a large `numeric(20,2)` value already fills). Impact: `Money` implementation only; the public API is unchanged.

**Decided:** `bigint` minor units.

**OQ-18 Validation library.** Options: Zod with NestJS 12 Standard Schema support, or `class-validator` DTO classes. Recommendation: Zod, one schema language for HTTP and SQS, no decorators on DTOs. Impact: interface layer only.

**Decided:** Zod.

**OQ-19 Lint and format.** Options: Biome, ESLint with typescript-eslint, oxlint. Recommendation: Biome (single fast tool for lint and format; enable `unsafeParameterDecoratorsEnabled` for Nest parameter decorators). Impact: S-01 only.

**Decided:** Biome.

**OQ-20 Database guards beyond the minimum.** The challenge requires uniqueness, immutability and non-negativity in the schema. This spec also adds the transaction state guard trigger, the wallet version guard, the deferred balance-to-ledger check and the composite ledger foreign keys. Recommendation: keep them (all verified in the lab, about 60 lines of SQL, and the schema design is evaluated). Alternative: drop them for less SQL. Impact: S-03 scope and the T-I1 cases.

**Decided:** keep the extra guards.

**OQ-21 Ledger page order.** Recommendation: newest first. Alternative: oldest first (statement order). Impact: cursor direction only.

**Decided:** newest first.

**OQ-22 Inbox `messageId` reuse with a different payload.** Recommendation: permanent error (DLQ) with `INBOX_PAYLOAD_MISMATCH`, because it is a producer contract violation that operators should see. Alternative: ack and log. Impact: DLQ semantics.

**Decided:** DLQ with `INBOX_PAYLOAD_MISMATCH`.

**OQ-23 Idempotency conflict arriving through SQS.** Recommendation: business-terminal: ack, `warn` log and metric, no inbox row. Alternative: DLQ for manual review. Impact: whether conflicts accumulate in the DLQ.

**Decided:** ack, log and metric.

---

## 5. Task breakdown

Ten slices, one PR each, built bottom-up. Each slice keeps `bun run check` green and ships its tests. A slice starts only after the open questions it depends on are decided. Every slice emits the logs and metrics of its own components through the `AppLogger` and `WageringMetrics` ports set up in S-01. S-08 adds only the samplers, the redaction config and the consolidated checks. Size is relative effort (S < M < L), not calendar time.

| Slice | Content | Requirements | Acceptance checks (tests) | Depends on | Size |
|---|---|---|---|---|---|
| S-01 Skeleton and Compose | `bun init`, strict `tsconfig`, Biome, `bunfig.toml`; NestJS app with role selection (`APP_ROLES`) and `/health/live`; Zod config; pino logger with AsyncLocalStorage context and prom-client registry with `/metrics` (base wiring only); Dockerfile; `docker-compose.yml` (postgres, sqs, setup placeholder, app-1..3); empty `scripts/migrate.ts` and `scripts/setup-sqs.ts` creating the three queues with the redrive policy; architecture test. | R-03, R-42 (live), R-60, P-1, P-2 | `bun run check` green; T-U7; `docker compose up` brings 3 instances answering `/health/live`; `setup-sqs` is idempotent (run twice). | OQ-02, OQ-05, OQ-18, OQ-19 | M |
| S-02 Domain model | `Money`, `Wallet`, `WalletLedgerEntry`, `WagerTransaction` (state machine), `FailureCode`, `ReferencePolicy`, `WagerTransactionProcessor`, `InboxMessage`, `OutboxMessage`, `RetrySchedule`, `IntegrationEvent` and the 4 events, `PayloadHash`. No infrastructure. | R-05, R-14 to R-18, R-20 to R-26, R-29, R-32, R-39 (hash), R-56 | T-U1 to T-U6 | S-01; OQ-07, OQ-08, OQ-14, OQ-17 | L |
| S-03 Schema and persistence | MikroORM config (explicit driver), initial migration (3.10) with `down()`, EntitySchema records, mappers via `rehydrate`, repositories, `MikroOrmUnitOfWork`, session and client timeouts via `driverOptions`, `pg-error-classifier`. | R-04 (code), R-09, R-13, R-16 to R-19 (DB) | T-I1; mapper round-trip tests | S-02; OQ-03, OQ-20 | M |
| S-04 Use cases and HTTP API | `CreateWallet` (with `OPENING`), `SubmitWagerTransaction` (3.8), queries, ledger cursor, `ReconcileWallet`; controllers, Zod schemas, `HttpErrorFilter`, correlation-id middleware, no-op auth guard and `ProviderIdentityPort`; `/health/ready` (PostgreSQL part). | R-06, R-20 to R-30, R-33, R-35 to R-41, R-42 (ready: PostgreSQL), R-43, R-52 (HTTP) | T-I2 (database part: wallet, transaction, ledger, outbox, events per outcome, `CreateWallet`), T-I3 (HTTP part), T-I7, T-I8; an in-process parallel version of the section 8 scenario | S-03; OQ-01, OQ-04, OQ-10, OQ-11, OQ-13, OQ-21 | L |
| S-05 SQS consumer | `WagerTransactionConsumer` (3.14), envelope schema, inbox, error classifier, visibility backoff, DLQ move, graceful shutdown (3.17); `/health/ready` SQS part. | R-42 (ready: SQS), R-44 to R-51 | T-I2 (inbox part), T-I3 (HTTP then SQS), T-I4, T-I5, T-I6 | S-04; OQ-22, OQ-23 | M |
| S-06 Outbox publisher | `PublishOutboxBatch`, `SqsEventPublisher`, `OutboxPublisherWorker` (`SKIP LOCKED`, backoff), outbox gauges. | R-08, R-53 to R-55 | Integration: two in-process publishers publish every row exactly once; a failed send schedules a retry; T-I2 (no event reaches the queue when the use case aborts). | S-04; OQ-16 | S |
| S-07 Pending-reference retrier | `RetryPendingReferences`, `PendingReferenceWorker` (3.16), `FAILED` path. | R-28, R-31 | Integration: reference-before-arrival settles; exhaustion rejects with `REFERENCE_NOT_FOUND` and an event; busy wallet skipped. | S-04; OQ-09, OQ-15 | S |
| S-08 Observability completion | DLQ-depth and outbox-lag samplers, pino redaction config, and a check that every metric and log event of 3.18 is emitted (the slices already emit their own). | R-57 to R-60, R-41 (metric) | T-I9 | S-05, S-06, S-07 | S |
| S-09 Concurrency and recovery suite | `test/support/instances.ts`, crash entrypoints, `expectWalletConsistent` wired into every wallet-touching test, T-C1 to T-C8. Fix whatever they expose. | R-01, R-02, R-07, R-10 to R-12, R-34, R-35, R-62 to R-64, E-02 to E-05, E-08 | T-C1 to T-C8 green three times in a row (flakiness check) | S-05, S-06, S-07 (S-08 for metric assertions) | L |
| S-10 Documentation | `README.md` (pt-BR: prerequisites, `docker compose up`, scripts, how to run each test tier, how to run 3 instances, how to reproduce the section 8 scenario, troubleshooting) and `ARCHITECTURE.md` (decisions, trade-offs, limitations listed in R-65, all OQ outcomes, no diagrams; the hand-drawn system diagram is linked or embedded by a human). | R-04, R-30, R-32, R-43, R-65 | Checklist review against R-65; every command in the README run from a clean clone. | S-01 to S-09; OQ-12 | S |

Parallelism: S-05, S-06 and S-07 depend only on S-04 and may proceed in parallel. Everything else is sequential.

Approved delivery plan (5 PR groups):

| PR | Slices | Notes |
|---|---|---|
| PR1 | S-01, S-02, and this decided `docs/spec.md` | Skeleton, Compose, domain model. |
| PR2 | S-03, S-04 | Schema, persistence, use cases, HTTP API. |
| PR3 | S-05, S-06, S-07 | Three parallel PRs on top of PR2. |
| PR4 | S-08, S-09 | Observability completion and the concurrency and recovery suite. |
| PR5 | S-10 | `README.md` and `ARCHITECTURE.md` (pt-BR). |

Budget: the critical path is S-01 to S-04, then S-05/S-06/S-07 in parallel, then S-08, S-09 and S-10. It fits the 3-day deadline only with agent-driven implementation, the parallel middle, and no optional differentials (OQ-06). If it slips, the order already protects the points: the financial core and its database guarantees (FIN, CON and IDE, 55 points) land first. S-09 holds the final proof of the eliminatory checks and is never cut; trim depth in S-08 and S-10 first.

---

## Appendix A: Toolchain facts verified for this spec

Lab run on 2026-11-05 in a scratch environment. Docker was not available on the lab host, so PostgreSQL ran from the `embedded-postgres` binaries and MiniStack from its PyPI package. S-01 later verified the Compose stack on Docker 29.7 / Compose v5.4 (2026-11-06): `postgres:18-alpine`, `ministackorg/ministack:1.5.37` and `oven/bun:1.4.4` pull and run, the `setup` job provisions the three FIFO queues (idempotent on re-run), and `app-1` to `app-3` report healthy and answer `/health/live`; `docker compose stop` exits an instance with code 0.

| Fact | How it was checked | Result |
|---|---|---|
| Bun 1.x installs and runs the stack | `npm i bun@1` gave Bun 1.4.4; `bun add` installed NestJS 12.3.3, MikroORM 7.2.7, `@mikro-orm/nestjs` 7.1.0, `@aws-sdk/client-sqs` 3.1162.0 | OK |
| NestJS DI by type under Bun (needs `emitDecoratorMetadata`) | Nest app with constructor injection of `EntityManager` and a service, Express platform, `MikroOrmModule.forRoot`; `curl` returned the wallet (`numeric` as string) | OK, after setting `driver: PostgreSqlDriver` |
| Shutdown hooks under Bun | `kill -TERM` gave `onApplicationShutdown` with `signal=SIGTERM` | OK |
| `tsc` type-checks decorators | `tsc --noEmit` with TS 6.0.3 and 7.0.2 | No decorator errors (only missing `@types/pg` in scratch files) |
| MikroORM `PESSIMISTIC_WRITE` across processes | 3 Bun processes on one wallet: section 8 scenario, same key 50x, 60 bets on a hot wallet | `20.00`/1 debit; 1 processed + 49 replays; 10 processed + 50 rejected; ledger consistent |
| Nested `transactional` propagation | `txid_current()` compared between outer and inner calls | Captured fork: separate tx (pitfall). Callback `em` and context `em`: joined. |
| Inbox `ON CONFLICT DO NOTHING` | `qb.insert().onConflict([...]).ignore()` with 3 concurrent duplicates | 1 processed, 2 duplicates, 1 inbox row, 1 debit |
| `FOR UPDATE SKIP LOCKED` outbox claiming | 3 concurrent publishers over 300 rows; MikroORM `PESSIMISTIC_PARTIAL_WRITE` SQL | 300 distinct published, max 1 per row; SQL ends with `for update skip locked` |
| `lock_timeout` | Second `FOR UPDATE` with `SET LOCAL lock_timeout='300ms'` | SQLSTATE `55P03` |
| Session and client timeouts | MikroORM `driverOptions` (`options: "-c ... -c transaction_timeout=800"`, `connectionTimeoutMillis`, `query_timeout`); every PostgreSQL process frozen with `SIGSTOP` | Session settings applied; transaction ended after about 920 ms; frozen server: `Query read timeout` after 1501 ms, `timeout exceeded when trying to connect` for a new connection; recovered after `SIGCONT` |
| Schema constraints and triggers (3.10) | The SQL block of 3.10 extracted verbatim from this file and applied to PostgreSQL 18.6; 18 `bun test` cases; the multi-process race scenarios re-run on it | All pass: append-only ledger (`UPDATE`/`DELETE`/`TRUNCATE` give `23001`), CHECKs (`23514`), version guard, both deferred ledger checks at `COMMIT` (`23000`: balance change without its exact entry, including a wrong `balance_before`, and an entry without its balance change), deferred composite FKs (ledger row before its transaction still commits), terminal and transition guard, immutable request columns, single reversal and wallet uniqueness (`23505`), composite ledger FKs (`23503`), `OPENING` reserved to `_system`, settled rows need an observed balance, and the `down()` drop order |
| Reversible migrations under Bun | `orm.migrator.up()` then `down()` on a TS migration class | Table created, then dropped |
| MiniStack 1.5.37 SQS FIFO | `@aws-sdk/client-sqs` under Bun | Dedup by `MessageDeduplicationId`; one group blocked while in flight; per-message `DelaySeconds` rejected (`InvalidParameterValue`); `ChangeMessageVisibility` redelivery after about 1 s with receive count 2; redrive to the FIFO DLQ after `maxReceiveCount` 3; long poll aborted by `AbortSignal` in about 300 ms |
| LocalStack requires an auth token | LocalStack blog, release 2026.03.0 (March 23, 2026) | "an auth token or CI auth token is required to start LocalStack for AWS"; Hobby plan is non-commercial |
| MiniStack image and license | PyPI project page | `ministackorg/ministack`, port 4566, `/_ministack/health`, MIT |
| Payload hash test vector | Bun `createHash` and `sha256sum` | `629836932b79106b99523d06a1e7fa80689b0ea1e1c47aa3f0a5a2c87d0c4344` |

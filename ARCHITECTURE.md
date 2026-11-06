# Arquitetura

Este documento registra as decisões de arquitetura do Distributed Wagering Processor, os trade-offs de cada uma e as limitações conhecidas. Identificadores de código (classes, tabelas, constraints, métricas, códigos de falha) ficam em inglês, como no código.

A especificação detalhada, com requisitos rastreáveis (`R-xx`), testes (`T-xx`) e as perguntas em aberto (`OQ-xx`) já decididas, está em [`docs/spec.md`](docs/spec.md). O enunciado em [`docs/challenge.md`](docs/challenge.md) é a fonte da verdade: se este documento e o enunciado divergirem, vale o enunciado.

## Sumário

1. [Diagrama do sistema](#1-diagrama-do-sistema)
2. [Estado da implementação](#2-estado-da-implementação)
3. [Visão geral e camadas](#3-visão-geral-e-camadas)
4. [Stack e ORM](#4-stack-e-orm)
5. [Money e seu mapeamento](#5-money-e-seu-mapeamento)
6. [Modelo de domínio e máquina de estados](#6-modelo-de-domínio-e-máquina-de-estados)
7. [Estratégia transacional](#7-estratégia-transacional)
8. [Estratégia de concorrência](#8-estratégia-de-concorrência)
9. [Garantias no schema do banco](#9-garantias-no-schema-do-banco)
10. [Idempotência e hash do payload](#10-idempotência-e-hash-do-payload)
11. [Taxonomia de códigos de falha](#11-taxonomia-de-códigos-de-falha)
12. [API HTTP e mapeamento de status](#12-api-http-e-mapeamento-de-status)
13. [Mensageria: inbox, consumidor SQS e DLQ](#13-mensageria-inbox-consumidor-sqs-e-dlq)
14. [Transactional Outbox](#14-transactional-outbox)
15. [Referências fora de ordem e janela de retentativa](#15-referências-fora-de-ordem-e-janela-de-retentativa)
16. [Desligamento gracioso](#16-desligamento-gracioso)
17. [Observabilidade](#17-observabilidade)
18. [Autenticação](#18-autenticação)
19. [Estratégia de testes](#19-estratégia-de-testes)
20. [Interpretações e decisões (OQ-01 a OQ-23)](#20-interpretações-e-decisões-oq-01-a-oq-23)
21. [Limitações conhecidas](#21-limitações-conhecidas)

## 1. Diagrama do sistema

> Espaço reservado para o diagrama de system design, desenhado à mão e adicionado por uma pessoa do time. Este documento descreve componentes, fluxos e fronteiras em texto e tabelas.

## 2. Estado da implementação

A entrega segue 5 PRs (seção 5 de `docs/spec.md`); a situação de cada slice está em [`README.md`](README.md#estado-da-implementação). Este documento descreve o desenho decidido e, onde algo ainda não está na branch principal, isso está indicado.

As seções 13, 14, 15, 16 e parte das 17 e 19 descrevem componentes dos slices S-05 a S-09, ainda não entregues. A tabela `inbox_messages`, a tabela `outbox_messages` com a escrita das linhas de evento, o `RetrySchedule` e as classes de domínio `InboxMessage` e `OutboxMessage` já estão entregues.

## 3. Visão geral e camadas

Arquitetura hexagonal (ports and adapters) em um único código e uma única imagem:

| Camada | Pasta | Responsabilidade | Pode importar |
|---|---|---|---|
| Domínio | `src/domain` | Entidades, value objects, serviços de domínio e eventos de integração. TypeScript puro. | apenas `src/domain` |
| Aplicação | `src/application` | Casos de uso (`CreateWallet`, `SubmitWagerTransaction`, `ReconcileWallet`, consultas) e as portas de que precisam (`WalletRepository`, `UnitOfWork`, `Clock`, `IdGenerator`, `WageringMetrics`, `AppLogger`, `ProviderIdentityPort` etc.). Classes simples, sem decorators do NestJS. | domínio, suas portas e `node:*` |
| Adaptadores de entrada | `src/interfaces` | Controllers HTTP, schemas Zod, filtro de erros, middleware de correlação; consumidor SQS e workers agendados. | aplicação, domínio, frameworks |
| Adaptadores de saída | `src/infrastructure` | Persistência MikroORM, cliente SQS, logger pino, métricas prom-client, configuração. | aplicação, domínio, frameworks |
| Raiz de composição | `src/main.ts`, `src/*.module.ts`, `src/roles.ts` | Monta a aplicação Nest para os papéis habilitados. | tudo |

A regra de dependência é verificada por `test/unit/architecture.test.ts`, que lê os imports de cada arquivo. O mesmo teste barra `parseFloat`, `parseInt`, `Number(` e `: number` em `src/domain/money`.

**Papéis de processo.** `APP_ROLES` (padrão `api,consumer,outbox,pending-reference`) escolhe o que cada processo roda: `api` serve HTTP; `consumer` consome `wager-transactions.fifo`; `outbox` publica eventos pendentes; `pending-reference` retenta transações `PENDING_REFERENCE`. Todos os papéis são seguros com qualquer número de instâncias ao mesmo tempo. `/health/*` e `/metrics` existem em toda instância.

**Por que um único deployable (OQ-05).** O enunciado exige que inbox, mudança financeira, ledger e outbox sejam confirmados na mesma transação SQL de um único banco. Separar API, consumidor e publicador em serviços distintos dividiria essa fronteira entre serviços que ainda compartilhariam o banco (um anti-padrão) ou exigiria transações distribuídas. Com uma imagem e papéis configuráveis, o Compose roda 3 instâncias com todos os papéis, o que exercita todos os caminhos concorrentes (vários consumidores, publicadores e retentadores), e em produção a mesma imagem pode ser implantada por papel só mudando `APP_ROLES`.

**Fluxos principais:**

1. **Submissão HTTP**: o controller valida corpo e header com Zod, monta `SubmitWagerTransactionCommand`, chama `SubmitWagerTransaction` e mapeia resultado ou erro para HTTP.
2. **Submissão SQS**: o consumidor valida o envelope, abre uma transação SQL por mensagem, grava a linha do inbox, chama o mesmo `SubmitWagerTransaction` (que se junta à transação), confirma e só então apaga a mensagem.
3. **Publicação do outbox**: o publicador reivindica linhas devidas com `FOR UPDATE SKIP LOCKED`, envia para `wagering-events.fifo`, marca como publicadas ou agenda nova tentativa e confirma.
4. **Retentativa de referência pendente**: o retentador pega transações `PENDING_REFERENCE` devidas, trava a carteira, reexecuta a mesma regra de domínio e persiste o resultado e seus eventos.

## 4. Stack e ORM

| Item | Escolha | Motivo |
|---|---|---|
| Runtime, pacotes, testes | Bun 1.4.4 | Obrigatório. Executa decorators do NestJS e o MikroORM direto do TypeScript. |
| Linguagem | TypeScript strict (`noUncheckedIndexedAccess`, `noImplicitOverride`) | O Bun transpila; `tsc --noEmit` só valida tipos. |
| Framework | NestJS 12 com Express | Obrigatório. |
| ORM | MikroORM 7 (`@mikro-orm/postgresql`) | Ver abaixo. |
| Banco | PostgreSQL 18 | Obrigatório. `transaction_timeout` exige 17+. |
| Emulador SQS | MiniStack 1.5.37 | Sem token de autenticação (OQ-02). |
| Validação | Zod 4, via `StandardSchemaValidationPipe` do Nest e direto no consumidor | Uma única linguagem de schema para HTTP e SQS, sem decorators em DTOs (OQ-18). |
| Logs | pino, JSON em stdout | Estruturado e rápido. |
| Métricas | prom-client, `GET /metrics` | Exposição Prometheus padrão. |
| Lint e formatação | Biome 2 | Uma ferramenta só (OQ-19). |
| IDs | UUIDv7 pela porta `IdGenerator` (`Bun.randomUUIDv7()`) | Chaves ordenadas no tempo; o domínio não depende do runtime. |

**Por que MikroORM (OQ-03).** É o ORM preferido pelo enunciado e oferece exatamente o que este desenho precisa: Unit of Work e Identity Map explícitos, `em.transactional()` com propagação, e `LockMode` que se traduz nas cláusulas de lock do PostgreSQL usadas aqui (`PESSIMISTIC_WRITE` gera `FOR UPDATE`; `PESSIMISTIC_PARTIAL_WRITE` gera `FOR UPDATE SKIP LOCKED`). Tudo foi verificado sob Bun antes da implementação (apêndice A de `docs/spec.md`). O TypeORM também funcionaria, mas não acrescenta nada aqui.

**Como o ORM é usado:**

- **Records de persistência separados do domínio.** `src/infrastructure/persistence/records/*.record.ts` definem classes simples com `EntitySchema` (sem decorators). Mappers em `mappers/` convertem record em objeto de domínio sempre pelas fábricas `rehydrate` e fazem o caminho inverso. O domínio não conhece tipos do ORM.
- **Migrations escritas à mão**, com `up()` e `down()` e SQL explícito para constraints, índices parciais e triggers, rodadas por `scripts/migrate.ts` com `transactional` e `allOrNothing`. O gerador de schema não é usado para DDL.
- **Regras aprendidas no laboratório:** repositórios e unit of work usam o `EntityManager` resolvido pelo contexto (nunca um fork capturado em closure, que abriria uma transação separada e quebraria a atomicidade); todo trabalho fora de HTTP roda em `RequestContext.create` com `allowGlobalContext: false`; `driver: PostgreSqlDriver` é explícito; funções de trigger fixam `search_path`; os records declaram relações `m:1` para que o Unit of Work insira os pais primeiro, e as FKs compostas do ledger são `DEFERRABLE INITIALLY DEFERRED`, então a correção não depende da ordem de flush.

**Risco conhecido e mitigação:** a armadilha da transação aninhada (um fork capturado abre outra transação). Mitigada pela regra acima e pelo teste de atomicidade T-I2.

## 5. Money e seu mapeamento

**Representação interna (OQ-17):** `bigint` com a quantidade de unidades menores (centavos) mais o código ISO-4217 da moeda. A escala é fixa em 2 para toda moeda, como exige o enunciado. Com escala fixa, somar, subtrair e comparar inteiros é exato, então nenhuma biblioteca decimal é necessária. `decimal.js` foi descartada: sua precisão é em dígitos significativos e o padrão (20) já é ocupado por um valor grande de `numeric(20,2)`.

**Contrato de entrada (OQ-08):** `Money.from({ amount, currency })` exige `amount` como string no formato `^(0|[1-9][0-9]{0,17})\.[0-9]{2}$` (não negativo, exatamente duas casas, até 18 dígitos inteiros como `numeric(20,2)`, sem sinal, expoente, espaços ou zeros à esquerda) e `currency` em `^[A-Z]{3}$`. `NaN`, `Infinity`, notação científica, string vazia, mais de 2 casas, negativos e números JSON são recusados com `InvalidMoneyError` (HTTP 400). Entradas com terceira casa (`"1.005"`) são recusadas, não arredondadas: nenhuma operação precisa de arredondamento. O formato estrito também deixa o hash de idempotência sem ambiguidade (`"25"` e `"25.00"` nunca coexistem).

**Reidratação:** `Money.rehydrate` aceita o mesmo formato com um `-` opcional, porque uma soma calculada sobre um ledger inconsistente pode ser negativa e a reconciliação precisa reportá-la. `add`, `subtract` e `negate` podem gerar negativos (por exemplo a `difference` da reconciliação); `toJSON()` e `toString()` sempre renderizam duas casas.

**Moedas:** qualquer operação binária entre moedas diferentes lança `CurrencyMismatchError`. BRL é a moeda dos exemplos; o modelo continua multimoeda e os testes cobrem `USD` contra uma carteira `BRL`.

**Mapeamento para o banco:** todas as colunas monetárias são `numeric(20,2)` com uma coluna `char(3)` de moeda ao lado. O MikroORM mapeia `decimal` em modo string (padrão na v7) e o mapper monta `Money` a partir da string e da moeda. Nenhum valor monetário vira `number` do JavaScript em nenhum ponto (domínio, DTOs, mensagens, colunas, eventos, logs), e o SQL nunca faz cast de dinheiro para `float`.

**Eventos:** o `data` dos eventos carrega `MoneyProps` (`{ amount, currency }` em strings), nunca a instância `Money`.

## 6. Modelo de domínio e máquina de estados

As classes de domínio têm construtores `private` ou `protected` e fábricas estáticas (`create`, `from`, `rehydrate`, `open`, `receive`, `enqueue`). Não há setters públicos; o estado muda só por métodos de transição nomeados. `rehydrate` reconstrói o estado persistido sem revalidar transições.

- **`Wallet`** (aggregate root). `Wallet.open` cria a carteira com `version` 1 e, se o saldo inicial for maior que zero, o lançamento de abertura. `debit` e `credit` checam a moeda, calculam o novo saldo, lançam `InsufficientFundsError` se ficaria negativo, incrementam `version` em exatamente 1 e **retornam** o `WalletLedgerEntry`. Como o lançamento é o valor de retorno dos únicos métodos que mudam o saldo, saldo e ledger não têm como divergir no domínio.
- **`WalletLedgerEntry`** só tem campos `readonly` e nenhum método de transição. `create` valida `balanceBefore +/- money == balanceAfter`, valor positivo, a mesma moeda em tudo e saldos não negativos.
- **`WagerTransaction`** guarda `observedBalance` e `observedWalletVersion`: o saldo e a versão da carteira vistos quando ela chegou ao status atual. É isso que um replay idempotente devolve. Também guarda o `correlationId` para que o retentador o propague para eventos e logs futuros.
- **`ReferencePolicy`** (pura) decide se uma referência resolvida é aceitável e, se não, com qual `FailureCode`.
- **`WagerTransactionProcessor`** (serviço de domínio puro) recebe a transação, a carteira travada, a referência resolvida (ou nenhuma), se a referência já foi revertida e o instante atual, e devolve `Applied`, `Rejected` ou `AwaitingReference`. A submissão e o retentador usam o mesmo processador, então as regras existem em um único lugar.
- **`OPENING`** é um tipo interno: `CreateWallet` cria a transação já `PROCESSED`, com provedor `_system` (o formato de `providerId` da API não pode começar com `_`), `externalTransactionId` igual ao id da carteira e chave `wallet-opening:{walletId}`. Ela não pode ser submetida por HTTP nem por SQS.

**Regras por tipo:**

| Tipo | Efeito | Referência |
|---|---|---|
| `BET` | Débito; `INSUFFICIENT_FUNDS` se faltar saldo. | Proibida. |
| `WIN` | Crédito. | Opcional; se presente, um `BET` `PROCESSED` do mesmo escopo (OQ-14). |
| `LOSS` | Nenhum movimento, nenhum lançamento; registrada como `PROCESSED`. Pode ter valor `0.00`. | Opcional, como `WIN`. |
| `REFUND` | Crédito do valor do `BET` referenciado. | Obrigatória; só `BET`. |
| `ROLLBACK` | Direção inversa à da referência (`BET` vira crédito; `WIN`/`REFUND` vira débito, com `REVERSAL_INSUFFICIENT_FUNDS` se faltar saldo). | Obrigatória; `BET`, `WIN` ou `REFUND`. |

Toda referência é resolvida por `(providerId, referenceExternalTransactionId)` e precisa pertencer ao mesmo provedor, jogador, carteira, moeda e rodada. Reversões não são parciais: o valor precisa ser igual ao da referência. Uma transação `REJECTED` não muda saldo nem gera lançamento.

**Máquina de estados de `WagerTransaction`:**

| De | Para | Gatilho |
|---|---|---|
| (nova) | `PENDING` | `WagerTransaction.create`. Nunca é confirmada como `PENDING`: a mesma transação SQL a leva adiante. |
| `PENDING` | `PROCESSED` | Regras passam e o efeito no saldo (se houver) é aplicado. |
| `PENDING` | `REJECTED` | Uma regra de negócio falha. |
| `PENDING` | `PENDING_REFERENCE` | Referência ausente, ou presente mas ela própria `PENDING_REFERENCE`. |
| `PENDING_REFERENCE` | `PENDING_REFERENCE` | Retentativa sem referência utilizável: incrementa `attempts` e agenda `nextAttemptAt`. |
| `PENDING_REFERENCE` | `PROCESSED` ou `REJECTED` | Retentativa resolve a referência; ou as tentativas se esgotam (`REFERENCE_NOT_FOUND` / `REFERENCE_NOT_PROCESSED`). |
| `PENDING_REFERENCE` | `FAILED` | Retentativa encontra um erro permanente que não é de negócio (`PROCESSING_FAILED`). |
| `PROCESSED`, `REJECTED`, `FAILED` | qualquer | Proibido: o domínio lança `InvalidTransactionStateError` (erro de programação, não um caminho de negócio) e o trigger do banco lança `restrict_violation`. |

**Quando `FAILED` é usado (OQ-15).** Só quando a retentativa de uma transação `PENDING_REFERENCE` encontra um erro permanente que não é de negócio (por exemplo uma violação de integridade que indica bug). No caminho síncrono, um erro de infraestrutura aborta a transação SQL, nada é persistido e o chamador reenvia (HTTP 503/500, retry ou DLQ no SQS). `FAILED` não gera evento de integração (não está na lista mínima); é registrado em log e métrica e auditável por `GET /wagering/transactions/:id`.

## 7. Estratégia transacional

**Uma transação SQL por operação de negócio.** A porta `UnitOfWork` expõe `run(work)`; `MikroOrmUnitOfWork` chama `em.transactional(work)` com a propagação padrão `REQUIRED`, então um `run` interno se junta ao externo. É assim que o consumidor SQS grava a linha do inbox e chama o mesmo caso de uso dentro de uma única transação.

Em `SubmitWagerTransaction` a mesma transação SQL grava: a `WagerTransaction`, o lançamento do ledger (se houver), a atualização da carteira (se mudou) e as linhas do outbox com os eventos do resultado. Na entrada por SQS, a linha do inbox também. `CreateWallet` grava carteira, transação `OPENING`, lançamento e outbox juntos. Nenhum evento sai antes do commit: só o publicador do outbox fala com a fila de eventos e ele lê apenas linhas confirmadas.

**Algoritmo de `SubmitWagerTransaction`:**

1. Validação de contrato no adaptador (Zod); falha é `ValidationError` e nada é persistido.
2. Cálculo do `payloadHash`.
3. Caminho rápido de idempotência, sem lock: busca por `(providerId, idempotencyKey)`; hash igual é replay, hash diferente é `IdempotencyConflictError`.
4. Abre o unit of work.
5. Trava a carteira com `SELECT ... FOR UPDATE` (`LockMode.PESSIMISTIC_WRITE`, `refresh: true`). Carteira inexistente: `WalletNotFoundError`.
6. Checagem autoritativa de idempotência sob o lock (uma requisição idêntica concorrente já confirmou a essa altura). Depois, se `(providerId, externalTransactionId)` já existe com outra chave: `ExternalTransactionConflictError`.
7. a 11. Cria a transação, checa escopo (jogador e moeda), resolve a referência, aplica o efeito pelo `WagerTransactionProcessor` e fecha o status com o saldo observado.
12. e 13. Persiste tudo e confirma.

**Nível de isolamento:** `READ COMMITTED` (padrão do PostgreSQL), de propósito. Depois de esperar por um lock de linha, `SELECT ... FOR UPDATE` devolve a versão mais recente confirmada da linha e os comandos seguintes enxergam os efeitos confirmados de quem segurava o lock. `REPEATABLE READ` geraria falhas de serialização em uma carteira disputada.

**Corridas em chaves únicas.** Uma violação `23505` em `wager_tx_provider_idempotency_uq`, `wager_tx_provider_external_uq` ou `wager_tx_single_reversal` aborta a transação. Quem é dono da transação mais externa repete a unidade inteira uma vez, em um `RequestContext` novo (nada da tentativa abortada sobra no Identity Map): o próprio `SubmitWagerTransaction` no HTTP, o handler por mensagem (inbox incluído) no SQS. Na repetição, o caminho rápido ou a checagem de referência devolve o replay, o conflito ou `REFERENCE_ALREADY_REVERSED`. Uma segunda violação vira `TransientInfrastructureError`.

**Timeouts.** Para que "PostgreSQL temporariamente indisponível" sempre termine em um erro transitório rápido, e nunca em requisição pendurada:

| Lado | Configuração | Padrão |
|---|---|---|
| Servidor, por sessão | `lock_timeout`, `statement_timeout`, `transaction_timeout`, `idle_in_transaction_session_timeout` | 2 s, 5 s, 8 s, 10 s |
| Cliente (pool `pg`) | `connectionTimeoutMillis`, `query_timeout`, `keepAlive` | 2 s, 6 s, ligado |

Os timeouts de cliente são necessários porque um servidor congelado (`docker compose pause`) não dispara timeouts de servidor. `pg-error-classifier.ts` traduz os erros de conexão e timeout do cliente e os SQLSTATEs `55P03`, `40P01`, `40001`, `08*`, `57P01` a `57P03`, `57014`, `25P03`, `25P04` e `53300` para `TransientInfrastructureError` (HTTP 503, retry no SQS). Violações de integridade fora das corridas documentadas indicam bug ou overflow: HTTP 500, erro permanente no SQS e `FAILED` no retentador.

## 8. Estratégia de concorrência

**Decisão (OQ-04): lock pessimista de linha por carteira.** Toda transação que mexe em saldo executa `SELECT ... FOR UPDATE` em exatamente uma linha de `wallets`, dentro da mesma transação SQL que grava transação, lançamento, carteira e outbox. A unidade de concorrência é o `walletId`.

| Situação | Como é tratada |
|---|---|
| Duas apostas disputando o mesmo saldo | A segunda espera o lock, lê o saldo já debitado (`READ COMMITTED`) e é rejeitada com `INSUFFICIENT_FUNDS` se não houver saldo. |
| Várias instâncias | O lock vive no PostgreSQL, então serializa escritores entre quaisquer processos e hosts. Não há lock em memória nem lock global. |
| Carteira muito disputada | Os concorrentes fazem fila no lock dentro do PostgreSQL e rodam um após o outro, sem desperdício com retries. A seção crítica é curta: sem I/O de rede (o evento é um insert no outbox), uma carteira travada, cerca de 5 comandos. `lock_timeout` (2 s) transforma filas patológicas em erro transitório (503 ou retry no SQS). |
| Carteiras diferentes | Locks de linha independentes, paralelismo total. |
| Deadlock | Impossível no desenho: cada transação trava no máximo uma carteira, e o retentador trava a carteira antes da transação, na mesma ordem de todos. |
| Ordem e deduplicação do broker | São só otimização. `MessageGroupId = walletId` reduz a disputa, mas a correção não depende disso: os testes de concorrência via SQS usam `MessageGroupId` aleatório justamente para o broker não serializar nada. |

**Defesa em profundidade:** o trigger `guard_wallet_update` recusa mudança de saldo sem `version` incrementada em exatamente 1, `CHECK (balance >= 0)` recusa negativos, e o constraint trigger diferido `wallets_balance_change_requires_ledger_entry` recusa no commit uma mudança de saldo sem o lançamento correspondente.

**Alternativas avaliadas e por que não:**

| Alternativa | Por que não |
|---|---|
| Optimistic locking (`UPDATE ... WHERE version = $v`) com retry limitado | Degrada muito sob disputa, precisa de orçamento de retries que ainda pode estourar e transforma o teste de 50 apostas iguais em uma tempestade de conflitos. O `version` continua existindo e é protegido pelo banco. |
| Update atômico condicional (`UPDATE ... SET balance = balance - $a WHERE balance >= $a`) | Rápido, mas move a regra de saldo para o SQL e ainda precisa do lock de linha para as checagens de idempotência e de reversão. |
| Advisory lock por carteira | Acrescenta um segundo mecanismo de lock ao lado dos locks de linha, sem ganho. |

**Trade-off assumido:** a vazão de uma única carteira é limitada pela duração da sua seção crítica. Para o domínio (um jogador raramente gera centenas de operações por segundo na mesma carteira) isso é aceitável, e carteiras diferentes escalam em paralelo.

**Evidência:** no laboratório da especificação, 3 processos Bun com `PESSIMISTIC_WRITE` no PostgreSQL 18 reproduziram o cenário obrigatório (um `PROCESSED`, um `REJECTED`, saldo `20.00`, 1 débito), a mesma chave 50 vezes (1 processada, 49 replays) e 60 apostas distintas de `10.00` sobre `100.00` (10 processadas, 50 rejeitadas, saldo `0.00`). Na implementação, `test/integration/wagering/mandatory-scenario.test.ts` verifica em processo o cenário obrigatório, a mesma aposta 50 vezes e 20 apostas distintas sobre `100.00`. As versões com 3 processos e via SQS (T-C1 a T-C4) chegam com a suíte de concorrência.

## 9. Garantias no schema do banco

Unicidade, imutabilidade e não negatividade são garantidas pelo schema, não só pelo código. Uma única migration inicial (`src/infrastructure/persistence/migrations/`) cria tudo, com `down()` reversível. Além do mínimo exigido, foram mantidas guardas extras (OQ-20): o trigger de estados da transação, a guarda de versão da carteira, as checagens diferidas entre saldo e ledger e as FKs compostas do ledger. São cerca de 60 linhas de SQL, todas verificadas.

| Garantia | Onde |
|---|---|
| Uma carteira por jogador e moeda | `wallets_player_currency_uq` |
| Saldos não negativos | `CHECK (balance >= 0)`, checagens de `balance_before`/`balance_after` e de `observed_balance` |
| `version` muda só com o saldo, de 1 em 1 | trigger `guard_wallet_update` |
| Toda mudança de saldo tem seu lançamento exato, e vice-versa | constraint triggers diferidos `wallets_balance_change_requires_ledger_entry` e `ledger_entry_requires_wallet_change`, `ledger_wallet_version_uq` |
| Aritmética do lançamento | `ledger_balanced`, `amount > 0` |
| Lançamento casa com sua transação e com a moeda da carteira | FKs compostas diferidas `ledger_transaction_fk`, `ledger_wallet_currency_fk` |
| No máximo um lançamento por transação e carteira | `ledger_one_entry_per_transaction_wallet` |
| Ledger append-only | triggers `ledger_forbid_update_delete`, `ledger_forbid_truncate` |
| Idempotência e unicidade do id externo | `wager_tx_provider_idempotency_uq`, `wager_tx_provider_external_uq` |
| No máximo uma reversão processada por referência | índice único parcial `wager_tx_single_reversal` |
| Uma abertura por carteira; `OPENING` só interno | `wager_tx_one_opening_per_wallet`, `wager_tx_opening_is_internal` |
| Estados terminais e colunas da requisição imutáveis; só transições válidas | trigger `guard_wager_transaction_update`, triggers de delete e truncate |
| Colunas dependentes de status coerentes | checagens `wager_tx_*_iff_*` e `*_when_*` |
| Deduplicação do inbox | chave primária `(consumer_name, message_id)` |

As checagens de ledger são `DEFERRABLE INITIALLY DEFERRED`: rodam no commit, então a correção não depende da ordem em que o ORM faz flush. As funções de trigger fixam `search_path`, então resolvem as tabelas qualquer que seja o `search_path` da sessão.

## 10. Idempotência e hash do payload

**Chave.** Header `Idempotency-Key` (no SQS, `data.idempotencyKey`), obrigatório, de 1 a 255 caracteres ASCII visíveis. Valor recomendado `"{providerId}:{externalTransactionId}"`, não imposto. **Escopo por provedor (OQ-13):** a unicidade é `(provider_id, idempotency_key)`, então a chave de um provedor nunca colide com a de outro.

**Subconjunto com hash** (exatamente estes campos): `providerId`, `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`, `money.amount`, `money.currency` e `referenceExternalTransactionId` (só quando presente). Ficam de fora a própria chave, `messageId`, `type`, `occurredAt`, headers, ids de correlação e qualquer campo desconhecido (removido na validação).

**Normalização:** UUIDs em minúsculas; `money.amount` já é canônico pelo formato estrito; referência ausente ou `null` é omitida; as demais strings são usadas como vieram (sem trim, sem mudança de caixa).

**JSON canônico:** chaves ordenadas por unidade de código UTF-16 (ordenação padrão do JavaScript) em todos os níveis, sem espaços, escape igual ao de `JSON.stringify`, sem membros `undefined`.

**Algoritmo:** SHA-256 dos bytes UTF-8 do JSON canônico, em hexadecimal minúsculo (`node:crypto`, `createHash("sha256")`). Implementado em `src/application/shared/canonical-json.ts` e `src/application/wagering/payload-hash.ts`.

**Vetor de teste** (a requisição de exemplo do enunciado):

```text
{"externalTransactionId":"transaction-123","gameId":"fortune-chimp","kind":"BET","money":{"amount":"25.00","currency":"BRL"},"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","providerId":"provider-a","roundId":"round-987","walletId":"0192f291-27dd-7d3f-8071-5f8685deef37"}
SHA-256: 629836932b79106b99523d06a1e7fa80689b0ea1e1c47aa3f0a5a2c87d0c4344
```

**Decisão:**

- Mesma chave e mesmo hash: replay do resultado armazenado (status, código de falha e saldo observado naquele momento), com `idempotentReplay: true` e o mesmo status HTTP da primeira resposta.
- Mesma chave e hash diferente: `409 IDEMPOTENCY_KEY_CONFLICT`, nunca replay.
- Mesmo `(providerId, externalTransactionId)` com outra chave: `409 EXTERNAL_TRANSACTION_CONFLICT`.
- Replay de uma transação ainda `PENDING_REFERENCE` devolve o estado atual (202); depois de resolvida, o resultado final.
- Como HTTP e SQS montam o mesmo comando, uma operação enviada por HTTP e repetida por SQS com a mesma chave é um replay.

**Onde vive o estado:** só na linha de `wager_transactions` no PostgreSQL. Não existe cache de respostas nem estado em memória, então a idempotência sobrevive a reinícios e funciona entre instâncias. A checagem é feita duas vezes: sem lock (caminho rápido) e sob o lock da carteira (autoritativa), com as constraints únicas como última barreira.

## 11. Taxonomia de códigos de falha

Os códigos são identificadores estáveis em inglês (`UPPER_SNAKE_CASE`) e nunca são traduzidos. Toda rejeição é final para seu `(providerId, externalTransactionId)`: reenviar devolve o resultado armazenado (mesma chave) ou `EXTERNAL_TRANSACTION_CONFLICT` (chave nova). "Corrigir e reenviar" significa sempre uma nova operação, com novo `externalTransactionId` e nova chave.

**Persistidos em transações `REJECTED`:**

| Código | Significado | Decisão do provedor |
|---|---|---|
| `INSUFFICIENT_FUNDS` | O valor do `BET` excede o saldo. | Desistir, ou mais tarde uma nova operação. |
| `REVERSAL_INSUFFICIENT_FUNDS` | Um `ROLLBACK` de `WIN` ou `REFUND` deixaria o saldo negativo. Distinto de aposta sem saldo. | Desistir; acompanhamento operacional. |
| `CURRENCY_MISMATCH` | A moeda difere da moeda da carteira. | Corrigir: nova operação com a moeda certa. |
| `PLAYER_WALLET_MISMATCH` | O `playerId` não é dono da carteira. A resposta omite `balance` (dado de outro jogador). | Corrigir: nova operação com a carteira certa. |
| `REFERENCE_NOT_FOUND` | A referência não apareceu dentro da janela de retentativa. | Investigar; nova operação quando a referência existir. |
| `REFERENCE_KIND_NOT_ALLOWED` | Tipo de referência não permitido (`REFUND` de não `BET`, `ROLLBACK` de `LOSS`/`ROLLBACK`/`OPENING`, `WIN`/`LOSS` referenciando não `BET`). | Corrigir a referência. |
| `REFERENCE_SCOPE_MISMATCH` | A referência é de outro jogador, carteira, moeda ou rodada. | Corrigir a referência. |
| `REFERENCE_NOT_PROCESSED` | A referência está `REJECTED` ou `FAILED`, ou ainda não estava `PROCESSED` quando a janela acabou. | Desistir. |
| `REFERENCE_ALREADY_REVERSED` | A referência já tem um `REFUND` ou `ROLLBACK` processado. | Desistir (já foi feito). |
| `REVERSAL_AMOUNT_MISMATCH` | O valor da reversão difere do valor da referência. | Corrigir: nova operação com o valor da referência. |

As checagens de referência seguem esta ordem: tipo permitido, escopo, status da referência (pendente mantém esta também pendente), valor da reversão, reversão anterior.

**Persistido em transações `FAILED`:** `PROCESSING_FAILED`, um erro permanente que não é de negócio durante a retentativa de uma `PENDING_REFERENCE`.

**Códigos de erro de requisição** (campo `code` do corpo HTTP; nunca persistidos como transação):

| Código | HTTP | Significado |
|---|---|---|
| `VALIDATION_FAILED` | 400 | Corpo, header, path ou query malformados (inclui `Money` inválido, `OPENING`, referência ausente ou proibida, cursor inválido). `details` lista os erros por campo. |
| `IDEMPOTENCY_KEY_CONFLICT` | 409 | Mesma chave, hash diferente. |
| `EXTERNAL_TRANSACTION_CONFLICT` | 409 | `(providerId, externalTransactionId)` já existe com outra chave. |
| `WALLET_ALREADY_EXISTS` | 409 | Já existe carteira para `playerId` + moeda; `details.walletId` traz o id. |
| `WALLET_NOT_FOUND` | 404 (path) / 422 (corpo) | Carteira inexistente. |
| `TRANSACTION_NOT_FOUND` | 404 | Id de transação ou id externo desconhecido. |
| `UNAUTHENTICATED` / `FORBIDDEN` | 401 / 403 | Reservados para o ponto de extensão de autenticação. |
| `SERVICE_UNAVAILABLE` | 503 + `Retry-After` | Falha transitória de infraestrutura. Seguro reenviar com a mesma chave. |
| `INTERNAL_ERROR` | 500 | Inesperado. Nada foi confirmado ou o resultado é idempotente; reenviar com a mesma chave. |

**Códigos do pipeline SQS:** `INBOX_PAYLOAD_MISMATCH` (mesmo `messageId` com outro conteúdo) vai para a DLQ, junto com os demais erros permanentes (seção 13).

## 12. API HTTP e mapeamento de status

**Regras de consistência, válidas para todos os endpoints (OQ-10):**

| Status | Significado | O provedor deve |
|---|---|---|
| `400` | A requisição está malformada. | Corrigir. |
| `404` | O recurso do path não existe. | Não reenviar. |
| `409` | Conflito com estado existente (idempotência, id externo, carteira duplicada). | Não reenviar como está. |
| `422` | Rejeição de negócio, incluindo corpo que referencia carteira inexistente. | Não reenviar como está. |
| `202` | Aceita, processamento pendente (`PENDING_REFERENCE`). | Aguardar ou consultar. |
| `503` | Falha transitória de infraestrutura. | Reenviar com a mesma chave após `Retry-After`. |
| `500` | Erro inesperado. | Reenviar com a mesma chave. |

O status de um resultado de transação é função pura do status atual dela: `PROCESSED` 201, `PENDING_REFERENCE` 202, `REJECTED` e `FAILED` 422. Assim, uma requisição idêntica sempre recebe a mesma resposta, como exige o enunciado; só `idempotentReplay` muda entre a primeira resposta e os replays. Todo corpo não 2xx tem um `code` legível por máquina; o `422` de processamento é o próprio resultado da transação com `code` igual ao `failureCode`, então o provedor também recebe `transactionId`, `status` e `balance`.

Alternativas descartadas: `200` para replays (diferenciaria replays pelo status, mas o enunciado pede a mesma resposta); `500` para `FAILED` (convidaria a reenviar um resultado terminal); `200` para todo resultado com o status só no corpo (obrigaria o provedor a interpretar o corpo para decidir se reenvia).

| Endpoint | Sucesso | Erros |
|---|---|---|
| `POST /wallets` | `201` `{ id, playerId, balance, version }` | 400, 409 `WALLET_ALREADY_EXISTS`, 503 |
| `GET /wallets/:walletId` | `200` | 400, 404, 503 |
| `GET /wallets/:walletId/ledger?cursor&limit` | `200` `{ items, nextCursor }` | 400, 404, 503 |
| `GET /wagering/transactions/:transactionId` | `200` visão da transação | 400, 404, 503 |
| `GET /providers/:providerId/wagering/transactions/:externalTransactionId` | `200` visão da transação | 400, 404, 503 |
| `POST /wagering/transactions` | `201` / `202` / `422` conforme o status | 400, 409, 422 `WALLET_NOT_FOUND`, 503, 500 |
| `POST /wallets/:walletId/reconciliation` | `200` (inclusive com `consistent: false`) | 400, 404, 503 |
| `GET /health/live` | `200` `{ status: "ok" }` | - |
| `GET /health/ready` | `200` `{ status: "ok", checks }` | `503` com a checagem que falhou |
| `GET /metrics` | `200` texto Prometheus | - |

**Carteira inexistente na submissão (OQ-11):** a transação não pode ser persistida (chave estrangeira), então não há como registrá-la de forma idempotente. Por HTTP responde `422 WALLET_NOT_FOUND`; por SQS é erro permanente (DLQ) para acompanhamento operacional.

**Paginação do ledger (OQ-21):** do mais novo para o mais antigo (`ORDER BY wallet_version DESC`). `nextCursor` é base64url de `{"v":<últimaVersão>}` e a próxima página usa `wallet_version < v`. É estável porque o ledger é append-only e as versões são únicas por carteira. `limit` padrão 50, máximo 200. O cliente trata o cursor como opaco; um cursor que não decodifica é 400.

**Reconciliação:** um único comando SQL (um snapshot consistente) lê o saldo armazenado, a soma do ledger e a contagem de lançamentos, além de uma checagem de encadeamento (cada `balance_before` igual ao `balance_after` anterior, via window function). `difference = stored - calculated`. Em divergência: log `warn` `reconciliation.divergence` (com `walletId`, sem valores), a métrica `wagering_reconciliation_divergences_total` incrementa e a resposta traz `consistent: false`. Nada é corrigido.

**Correlação:** `X-Correlation-Id` é aceito se casar com `^[A-Za-z0-9._:-]{1,128}$`, senão é gerado. Toda requisição também ganha um `requestId` (UUIDv7), usado como `causationId` dos eventos que produz. Ambos voltam nos headers (`X-Correlation-Id`, `X-Request-Id`) e aparecem nos logs.

## 13. Mensageria: inbox, consumidor SQS e DLQ

> Componente do slice S-05, em andamento. Descrito conforme a especificação.

**Filas** (criadas de forma idempotente por `scripts/setup-sqs.ts`, já entregue): `wager-transactions.fifo` com `VisibilityTimeout=30` e redrive para `wager-transactions-dlq.fifo` após 5 recebimentos, e `wagering-events.fifo` para os eventos do outbox.

**Envelope de entrada:** `{ messageId, type: "WagerTransactionRequested", occurredAt, data: { providerId, externalTransactionId, idempotencyKey, playerId, walletId, roundId, gameId, kind, money, referenceExternalTransactionId? } }`. O `data` passa pelo mesmo schema Zod do corpo HTTP. Produtores devem usar `MessageGroupId = walletId` e `MessageDeduplicationId = messageId`, mas o consumidor não depende de nenhum dos dois.

**Processamento por mensagem**, dentro de `RequestContext.create`:

1. Valida JSON e envelope. O `payloadHash` do inbox é o SHA-256 do JSON canônico do `data` (campos de transporte como `occurredAt` ficam de fora, então um produtor que reescreve o carimbo no reenvio ainda é duplicata).
2. Abre o unit of work e insere a linha do inbox com `INSERT ... ON CONFLICT (consumer_name, message_id) DO NOTHING`. Nenhuma linha inserida: lê a existente; hash igual é duplicata (confirma e apaga); hash diferente é erro permanente `INBOX_PAYLOAD_MISMATCH` (OQ-22).
3. Chama `SubmitWagerTransaction`, que se junta à mesma transação, marca `processed_at` no inbox e confirma.
4. Só depois do commit: `DeleteMessage`. Se o delete falhar, a mensagem volta, o passo 2 encontra a linha do inbox e ela é apagada então.

O lote recebido é agrupado por `MessageGroupId`: grupos rodam em paralelo (até `SQS_HANDLER_CONCURRENCY`) e mensagens do mesmo grupo em sequência. Antes de começar uma mensagem, se mais da metade do visibility timeout já passou, a visibilidade é estendida, para que mensagens ainda na fila local não fiquem visíveis para outra instância.

**Classificação de erros:**

| Classe | Casos | Ação |
|---|---|---|
| Negócio, terminal | `PROCESSED`, `REJECTED`, `PENDING_REFERENCE`, replay, duplicata do inbox, `IDEMPOTENCY_KEY_CONFLICT`, `EXTERNAL_TRANSACTION_CONFLICT` | Confirma e apaga. Conflitos (OQ-23) fazem rollback (sem linha no inbox), são apagados, registrados como `warn` e contados. |
| Transitório | `TransientInfrastructureError`, throttling ou rede do SQS, e qualquer erro não classificado | Não apaga. `ChangeMessageVisibility` para o atraso do `RetrySchedule` (cerca de 2, 4, 8, 16 s). Após 5 recebimentos, a redrive policy leva para a DLQ. |
| Permanente | JSON ou envelope inválido, `type` desconhecido, `OPENING`, `ValidationError`, `WalletNotFoundError`, `INBOX_PAYLOAD_MISMATCH`, violações de integridade | Envia o mesmo corpo para a DLQ com os atributos `failureReason` e `failureCode`, depois apaga. Uma queda entre os dois só gera uma cópia duplicada na DLQ, absorvida pela deduplicação FIFO. |

**Decisões e trade-offs:**

- Filas FIFO recusam `DelaySeconds` por mensagem (verificado no MiniStack), então o backoff usa o visibility timeout. Uma mensagem esperando backoff bloqueia seu grupo, o que preserva a ordem por carteira na retentativa.
- O visibility timeout (30 s) fica acima do pior tempo de handler: `transaction_timeout` (8 s) limita cada tentativa e a única repetição por corrida em chave única leva a no máximo 16 s.
- Erros desconhecidos contam como transitórios de propósito: um falso "permanente" mandaria cedo para a DLQ uma mensagem recuperável, enquanto um falso "transitório" custa só 4 retries até a redrive policy mandá-la para a DLQ de qualquer forma.
- A fila é um canal interno confiável, mas o `providerId` das mensagens passa pela mesma validação de formato e toda busca é escopada por ele.

## 14. Transactional Outbox

> A escrita das linhas do outbox já está entregue. O publicador é do slice S-06, em andamento, e é descrito conforme a especificação.

**Escrita:** todo caso de uso que produz eventos insere as linhas de `outbox_messages` no seu próprio unit of work. Nada mais envia eventos.

**Eventos (mínimo do enunciado):**

| Evento | Quando |
|---|---|
| `WagerTransactionProcessed` | Toda transação aplicada, `LOSS` incluída. |
| `WalletBalanceChanged` | Só quando o saldo muda (inclui `OPENING` com saldo inicial maior que zero). |
| `WagerTransactionRejected` | Rejeição de negócio, inclusive quando as tentativas de referência se esgotam. |
| `WagerTransactionPendingReference` | Uma vez, quando a transação entra em `PENDING_REFERENCE`. |

Cada evento é uma subclasse de `IntegrationEvent<T>` com `eventType` e `version` declarados no tipo; `toJSON()` devolve `{ eventId, eventType, aggregateId, correlationId, causationId?, occurredAt, version, data }`. `playerId` e payloads completos ficam de fora dos eventos de propósito. Replays não geram eventos; `FAILED` também não.

**Publicador** (papel `outbox`), a cada tick em uma transação nova:

1. `SELECT ... WHERE published_at IS NULL AND next_attempt_at <= now() ORDER BY occurred_at, id LIMIT n FOR UPDATE SKIP LOCKED`.
2. `SendMessageBatch` para `wagering-events.fifo` com `MessageGroupId = aggregate_id` e `MessageDeduplicationId = eventId`, timeout de 5 s.
3. Sucesso: `published_at = now()`. Falha: `attempts + 1`, `next_attempt_at` pelo `RetrySchedule` (1 s a 5 min) e `last_error` truncado, sem payload. Linhas nunca desistem: perder evento é proibido, e a métrica de lag dispara o alarme.
4. Confirma. Se o lote veio cheio, roda de novo na hora; senão, espera `OUTBOX_POLL_INTERVAL_MS`.

**Por que funciona com publicadores concorrentes:** `SKIP LOCKED` entrega conjuntos disjuntos de linhas a publicadores concorrentes (laboratório: 3 publicadores, 300 linhas, cada linha publicada exatamente uma vez). Os locks ficam presos durante o envio, então se um publicador cai, sua transação aborta e as linhas ficam disponíveis para outra instância na hora. Não é preciso coluna de lease.

**Duplicatas são limitadas e seguras:** uma queda depois do envio e antes do commit republica aquele lote uma vez. Dentro de 5 minutos a deduplicação FIFO descarta; depois disso, consumidores deduplicam pelo `eventId` (contrato documentado para consumidores). Não há garantia de ordem entre agregados nem entre publicadores; `WalletBalanceChanged.walletVersion` permite ordenar os eventos de saldo.

**Trade-off:** manter uma transação aberta durante uma chamada SQS (no máximo 5 s) é uma escolha KISS no lugar de uma coluna de lease. Ela só trava linhas do outbox, que nada mais atualiza.

**Destino dos eventos (OQ-16):** fila SQS FIFO `wagering-events.fifo` em vez de tópico SNS FIFO: menos peças, testável no MiniStack, deduplicação por `eventId`. Trocar depois afeta só o `SqsEventPublisher`.

## 15. Referências fora de ordem e janela de retentativa

> Componente do slice S-07, em andamento. A entrada em `PENDING_REFERENCE` no caminho síncrono já está entregue; o retentador é descrito conforme a especificação.

Um `REFUND`, `ROLLBACK`, `WIN` ou `LOSS` cuja referência ainda não existe é persistido como `PENDING_REFERENCE` (HTTP 202) com `attempts = 0` e `nextAttemptAt = agora + 1 s`, e gera `WagerTransactionPendingReference`.

**Retentador** (papel `pending-reference`), a cada `PENDING_REFERENCE_POLL_INTERVAL_MS`:

1. Lê até 20 candidatos devidos (`status = 'PENDING_REFERENCE' AND next_attempt_at <= now()`), sem lock.
2. Para cada um, em seu próprio unit of work: trava a carteira com `FOR UPDATE` limitado por `lock_timeout` (uma carteira disputada é aguardada, não pulada, para que suas referências pendentes não passem fome), recarrega a transação e confirma que ainda está pendente e devida (outra instância pode já tê-la tratado), resolve a referência e roda o mesmo `WagerTransactionProcessor` da submissão.
3. `Applied` ou `Rejected` persistem o resultado e seus eventos. `AwaitingReference` incrementa `attempts`; ao chegar no limite, a transação vira `REJECTED` com `REFERENCE_NOT_FOUND` (a referência nunca apareceu) ou `REFERENCE_NOT_PROCESSED` (existe mas continua pendente) e publica `WagerTransactionRejected`; senão, agenda a próxima tentativa.
4. Erro em um candidato nunca interrompe o tick. Transitório deixa a linha para o próximo tick. Permanente faz rollback e, em uma transação nova, marca `FAILED PROCESSING_FAILED` se ainda estiver pendente.

**Janela escolhida (OQ-09): cerca de 1 hora.** `PENDING_REFERENCE_MAX_ATTEMPTS = 20`, base 1 s, teto 300 s. Atrasos antes de cada tentativa: 1, 2, 4, 8, 16, 32, 64, 128, 256 s e depois onze vezes 300 s, total de 3811 s (cerca de 63,5 minutos, mais ou menos o jitter de 20%).

**Justificativa:** entrega fora de ordem entre uma aposta e sua reversão costuma se resolver em segundos (consumo paralelo, reentrega do SQS), mas incidentes do lado do provedor e reprocessamentos podem demorar bem mais. Uma hora dá margem para a operação se recuperar antes de um `REFERENCE_NOT_FOUND` definitivo, e o teto de 5 minutos mantém a carga de retentativas desprezível. Alternativas descartadas: 10 tentativas em cerca de 5 minutos (curto demais para incidentes reais) e TTL de 24 horas (deixaria o provedor sem resposta definitiva por tempo demais). Tudo é configurável; os testes usam milissegundos.

**Política de backoff única:** `RetrySchedule` (`min(base * 2^attempt, cap)` com jitter de 20%) é a mesma para retries do SQS, do outbox e do retentador.

**Latência:** uma reversão que chega antes espera a próxima tentativa agendada depois que a referência aparece (no máximo o degrau atual do backoff). Acordar dependentes na hora é uma otimização possível, não construída (KISS).

## 16. Desligamento gracioso

> Parte do slice S-05, em andamento.

Com `app.enableShutdownHooks()`, ao receber `SIGTERM`: a readiness passa a responder 503; o consumidor para de buscar e aborta o long poll em andamento; mensagens recebidas e não iniciadas voltam a ficar visíveis na hora (`ChangeMessageVisibility(0)`); handlers em andamento têm até `SHUTDOWN_GRACE_MS` (20 s) para confirmar e apagar, e os que passarem do prazo voltam a ficar visíveis (se a transação deles confirmar depois, a reentrega é uma duplicata do inbox); o publicador e o retentador terminam o tick atual; por fim `app.close()` drena as conexões HTTP e fecha o pool. O Compose usa `stop_grace_period: 30s`, acima dos 10 s padrão do Docker.

## 17. Observabilidade

**Logs:** pino, JSON em stdout, um logger com contexto via AsyncLocalStorage definido pelo middleware HTTP, pelo consumidor (por mensagem) e pelos workers. Cada linha traz `correlationId` e, quando conhecidos, `messageId`, `transactionId`, `walletId` e `providerId`, além de `event` (nome estável como `transaction.processed`), `role` e `instanceId`.

**Nunca são logados:** valores, saldos, `playerId`, corpos de requisição ou mensagem, chaves de idempotência, headers além do correlation id e receipt handles do SQS. Uma lista de `redact` do pino reforça isso (S-08).

**Métricas** (`GET /metrics`):

| Métrica | Cobre |
|---|---|
| `wagering_transactions_total{kind,status,source}` | transações por status |
| `wagering_duplicates_total{type}` | duplicatas detectadas (inbox, replay idempotente) |
| `wagering_idempotency_conflicts_total{source,code}` | payloads conflitantes |
| `wagering_retries_total{component}` | retentativas (sqs, outbox, pending_reference, unique_race) |
| `wagering_dlq_messages_total{reason}` e `wagering_dlq_depth{queue}` | mensagens na DLQ |
| `wagering_wallet_lock_wait_seconds` e `wagering_lock_conflicts_total{reason}` | espera e conflitos de lock |
| `wagering_outbox_lag_seconds` | idade da linha mais antiga não publicada |
| `wagering_processing_duration_seconds{source,kind,outcome}` | latência de processamento |
| `wagering_reconciliation_divergences_total` | divergências de reconciliação |

As métricas do caminho de submissão HTTP e da reconciliação já estão entregues; as do consumidor, do outbox e do retentador chegam com seus slices, e os amostradores de profundidade da DLQ e de lag do outbox com S-08.

**Health:** `/health/live` nunca toca dependências. `/health/ready` executa `SELECT 1` no PostgreSQL e, com S-05, `GetQueueAttributes` na fila de entrada, ambos com timeout de 1 s. Hoje a readiness verifica só o PostgreSQL.

## 18. Autenticação

**Decisão (OQ-01): não implementada, com ponto de extensão explícito.** Autenticação vale 0 pontos e o enunciado aceita explicitamente essa opção. Uma integração real com IdP custaria cerca de meio dia (bootstrap de realm, obtenção de token em todo teste HTTP, tempo de subida do Compose), tirado de áreas pontuadas. Também não há tabela própria de usuários com hash de senha.

**O que existe no código:**

- A porta `ProviderIdentityPort` (`src/application/ports/provider-identity.port.ts`), que resolve as credenciais do chamador em uma `ProviderIdentity` (`anonymous` ou `provider` com `providerId`).
- O adaptador no-op `AnonymousProviderIdentity`, que devolve sempre `anonymous`.
- O guard global `ProviderAuthGuard`, aplicado a todas as rotas de provedor (não a `/health/*` nem a `/metrics`), que passa o header `Authorization` para a porta e guarda a identidade na resposta. Com o adaptador no-op, todos passam.
- Os códigos `UNAUTHENTICATED` (401) e `FORBIDDEN` (403) reservados na taxonomia.

**Desenho pretendido (documentado, não construído):**

1. Cada provedor é um cliente OIDC de um Keycloak ou Zitadel e obtém tokens pelo fluxo client credentials.
2. Um novo adaptador de `ProviderIdentityPort` valida o JWT (assinatura pelo JWKS do IdP, `iss`, `aud`, expiração) e devolve a identidade com o claim `provider_id`. Token ausente ou inválido: `401 UNAUTHENTICATED`.
3. O caso de uso compara o `provider_id` do token com `command.providerId`; diferente: `403 FORBIDDEN`. Assim um provedor não consegue operar em nome de outro.
4. Trocar o no-op pelo adaptador real é só mudar o provider no módulo Nest; controllers e casos de uso não mudam.
5. Mensagens SQS não passam pelo guard (canal interno confiável), mas o `providerId` continua passando pela validação de formato e toda busca é escopada por ele.
6. Health checks continuam abertos.

## 19. Estratégia de testes

| Camada | Pasta | Dependências | Situação |
|---|---|---|---|
| Unidade | `test/unit` | nenhuma | Entregue: `Money`, `Wallet`, ledger, `WagerTransaction`, processador de regras, eventos, hash, configuração, logger, borda HTTP e o teste de arquitetura. |
| Integração | `test/integration` | PostgreSQL e MiniStack do Compose | Entregue para schema e constraints, mappers, provisionamento de filas, atomicidade, idempotência, API HTTP, reconciliação e o cenário obrigatório em processo. Inbox, retry e DLQ e desligamento gracioso chegam com S-05; observabilidade com S-08. |
| Concorrência | `test/concurrency` | PostgreSQL e MiniStack; sobe processos da aplicação | Pendente (S-09): T-C1 a T-C8. |

**Regras:**

- **Infraestrutura real:** integração e concorrência rodam contra PostgreSQL e MiniStack reais, sem mocks de `pg`, MikroORM ou cliente SQS.
- **Isolamento sem limpeza:** cada teste cria suas próprias carteiras, jogadores e provedores (UUIDv7) e cada arquivo usa filas com nome único. Nada é truncado (o ledger proíbe).
- **Invariante final:** todo teste que toca carteiras verifica no `afterEach` que o saldo armazenado é igual ao saldo reconstruído pelo ledger, que as versões do ledger são contíguas, que cada `balance_before` é o `balance_after` anterior e que o número de lançamentos bate com as transações processadas que afetam saldo (`test/support/wallet-consistency.ts`).
- **Determinismo:** sem sleeps fixos para sincronizar; corridas começam de uma barreira compartilhada; atrasos de retry são encurtados por configuração.
- **Falhas injetadas sem ganchos em produção (S-09):** cenários de queda usam entrypoints de teste que montam a aplicação real e trocam um único provider por um wrapper que faz `SIGKILL` no ponto escolhido. O código de produção não tem chaves de teste.
- **Corridas reais via SQS (S-09):** as variantes SQS enviam cada mensagem com `MessageGroupId` aleatório e verificam que `wagering_lock_conflicts_total{reason="contended"}` subiu, o que prova que o banco, e não o broker, serializou as operações.

## 20. Interpretações e decisões (OQ-01 a OQ-23)

Todas decididas em 2026-11-06. Detalhes e alternativas na seção 4 de `docs/spec.md`.

| Item | Decisão | Justificativa |
|---|---|---|
| OQ-01 Autenticação | Guard no-op `ProviderAuthGuard` + `ProviderIdentityPort`, desenho com Keycloak/Zitadel documentado. | Vale 0 pontos, aceito pelo enunciado; o tempo vai para áreas pontuadas (seção 18). |
| OQ-02 Emulador SQS | MiniStack por padrão e nos testes; LocalStack documentado como alternativa. | Desde a versão 2026.03 o LocalStack exige token de autenticação; o MiniStack (MIT) não exige e passou em todas as checagens FIFO necessárias. |
| OQ-03 ORM | MikroORM 7. | Preferido pelo enunciado; Unit of Work, `transactional()` e `LockMode` com `SKIP LOCKED` (seção 4). |
| OQ-04 Locking | Lock pessimista de linha por carteira. | Melhor sob disputa, regras no domínio, sem laço de retry, sem deadlock (seção 8). |
| OQ-05 Deployable | Um código, uma imagem, todos os papéis em cada instância, 3 instâncias no Compose. | Mantém a fronteira transacional única; implantação por papel é só configuração (seção 3). |
| OQ-06 Diferenciais | Nenhum agendado. | Foco nos 100 pontos avaliados. |
| OQ-07 Unicidade de reversão | Estrita: no máximo uma reversão processada (de qualquer tipo) por transação referenciada. | A leitura literal ("mesmo tipo de operação") permitiria um `REFUND` e um `ROLLBACK` do mesmo `BET`, creditando duas vezes. Um `ROLLBACK` de um `REFUND` continua possível, porque referencia o `REFUND`. |
| OQ-08 Formato do valor | Estrito, exatamente duas casas decimais. | O enunciado fixa escala 2, e o formato estrito deixa o hash sem ambiguidade. `"25"` recebe 400. |
| OQ-09 Limite de `PENDING_REFERENCE` | 20 tentativas, base 1 s, teto 300 s (cerca de 63,5 min), configurável. | Seção 15. |
| OQ-10 Status HTTP dos resultados | Função do status da transação: 201, 202, 422; conflitos 409; transitório 503 com `Retry-After`. | Mesma resposta para a primeira chamada e os replays (seção 12). |
| OQ-11 Carteira inexistente na submissão | HTTP 422 `WALLET_NOT_FOUND`; SQS para a DLQ. | A transação não pode ser persistida (FK); a DLQ preserva a mensagem para a operação. |
| OQ-12 Idioma do `ARCHITECTURE.md` | pt-BR, com identificadores de código em inglês. | A banca avaliadora é o público. |
| OQ-13 Escopo da chave de idempotência | Por provedor. | A chave de um provedor nunca colide com a de outro. |
| OQ-14 Referências de `WIN`/`LOSS` e valor zero | `WIN` e `LOSS` aceitam referência opcional a um `BET` processado do mesmo escopo; `BET` não aceita referência; só `LOSS` pode ter `0.00`. | Um `WIN` zero é erro de validação; o provedor envia `LOSS`. |
| OQ-15 Uso de `FAILED` | Só na retentativa de `PENDING_REFERENCE` com erro permanente que não é de negócio; sem evento. | No caminho síncrono um erro aborta a transação e o chamador reenvia (seção 6). |
| OQ-16 Destino dos eventos | Fila SQS FIFO `wagering-events.fifo`. | Menos peças, testável no MiniStack (seção 14). |
| OQ-17 Representação de `Money` | `bigint` de unidades menores. | Exato, sem dependência, sem precisão global (seção 5). |
| OQ-18 Validação | Zod. | Uma linguagem de schema para HTTP e SQS, sem decorators em DTOs. |
| OQ-19 Lint e formatação | Biome. | Uma ferramenta rápida para os dois. |
| OQ-20 Guardas extras no banco | Mantidas. | Verificadas no laboratório, cerca de 60 linhas de SQL, e o desenho do schema é avaliado (seção 9). |
| OQ-21 Ordem da página do ledger | Do mais novo para o mais antigo. | Mostra primeiro os lançamentos recentes; a escolha afeta só a direção do cursor. |
| OQ-22 `messageId` reutilizado com outro payload | DLQ com `INBOX_PAYLOAD_MISMATCH`. | É violação de contrato do produtor e a operação precisa ver. |
| OQ-23 Conflito de idempotência via SQS | Terminal de negócio: apaga a mensagem, log `warn` e métrica, sem linha no inbox. | Um conflito é resultado de negócio, não falha de processamento; mandá-lo para a DLQ só acumularia mensagens sem ação possível. |

## 21. Limitações conhecidas

- **Vazão por carteira:** limitada pela duração da seção crítica sob o lock de linha. Carteiras diferentes escalam em paralelo; uma única carteira muito quente não.
- **Overflow de `numeric(20,2)`:** um crédito que passe de cerca de 10^18 unidades gera SQLSTATE `22003`, tratado como erro permanente (HTTP 500, DLQ no SQS).
- **Lacuna residual do ledger:** um lançamento falso na versão 1 de uma carteira aberta com saldo zero passa pelas duas checagens diferidas; a reconciliação (soma e encadeamento) detecta.
- **Retenção:** linhas antigas de `inbox_messages` (além dos 14 dias de retenção máxima do SQS) e linhas publicadas de `outbox_messages` poderiam ser expurgadas por um job futuro, não construído. Ledger e transações nunca são expurgados.
- **Eventos:** entrega pelo menos uma vez, sem ordem entre agregados nem entre publicadores; consumidores deduplicam por `eventId` e ordenam eventos de saldo por `walletVersion`. Uma transação de outbox fica aberta por até 5 s durante o envio ao SQS.
- **Latência de referências pendentes:** uma reversão que chega antes da referência espera o próximo degrau do backoff depois que a referência aparece, sem acordar dependentes na hora.
- **Autenticação:** apenas o ponto de extensão no-op; nenhum provedor é autenticado (seção 18).
- **`FAILED` sem evento:** transações `FAILED` são visíveis por log, métrica e consulta, não por evento de integração.
- **Double-entry, OpenTelemetry, dashboards, OpenAPI e teste de carga:** não construídos (OQ-06).
- **LocalStack:** documentado como alternativa, mas apenas o MiniStack é testado.
- **Entrega parcial:** consumidor SQS, publicador do outbox, retentador, observabilidade completa e suíte de concorrência ainda estão em andamento (seção 2). Este documento passará por uma revisão de exatidão quando esses PRs entrarem.

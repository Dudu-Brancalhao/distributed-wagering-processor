# Distributed Wagering Processor

Serviço de carteira e processamento de apostas (desafio técnico Jungle Gaming). Ele recebe transações de provedores de jogos por HTTP e por SQS, aplica as regras de `BET`, `WIN`, `LOSS`, `REFUND` e `ROLLBACK` sobre carteiras com saldo em `Money` exato, mantém um ledger imutável e publica eventos de integração com Transactional Outbox.

- Enunciado (fonte da verdade): [`docs/challenge.md`](docs/challenge.md)
- Especificação de implementação: [`docs/spec.md`](docs/spec.md)
- Decisões, trade-offs e limitações: [`ARCHITECTURE.md`](ARCHITECTURE.md)

## Diagrama do sistema

![Diagrama de system design](docs/system-design.png)

## Estado da implementação

A entrega foi dividida em PRs por slice (seção 5 de `docs/spec.md`). Este README descreve o que está na branch principal; o que ficou de fora está em [`ARCHITECTURE.md`, Limitações conhecidas](ARCHITECTURE.md#21-limitações-conhecidas).

| Parte | Slices | Situação |
|---|---|---|
| Esqueleto, Compose, modelo de domínio | S-01, S-02 | Entregue |
| Schema PostgreSQL, persistência, casos de uso e API HTTP | S-03, S-04 | Entregue |
| Consumidor SQS, publicador do outbox, retentativa de `PENDING_REFERENCE` | S-05, S-06, S-07 | Entregue |
| Observabilidade | S-08 | Parcial: logs com contexto e métricas entregues; amostrador de profundidade da DLQ e `redact` do pino não construídos |
| Suíte de concorrência e recuperação | S-09 | Parcial: só a prova de concorrência (T-C1 a T-C3, com 3 processos); T-C4 separado e T-C5 a T-C8 cortados |

## Pré-requisitos

| Ferramenta | Versão | Uso |
|---|---|---|
| Docker com Docker Compose v2 | Docker 29.x, Compose v5.x verificados | Sobe PostgreSQL, MiniStack (SQS) e as 3 instâncias |
| Bun | 1.4.x (1.4.4 verificado) | Runtime, gerenciador de pacotes e test runner, para rodar testes e scripts fora do container |
| `curl` e `jq` | qualquer | Apenas para os exemplos de chamadas abaixo |

Portas usadas no host: `5432` (PostgreSQL), `4566` (MiniStack), `3001`, `3002` e `3003` (instâncias `app-1`, `app-2` e `app-3`).

Nenhuma conta ou token é necessário: o emulador padrão é o MiniStack, que não exige autenticação (ver `ARCHITECTURE.md`, emulador SQS).

## Subindo o ambiente

```bash
docker compose up -d --build
```

O Compose sobe, nesta ordem:

1. `postgres` (PostgreSQL 18) e `sqs` (MiniStack 1.5.37), com healthchecks. O script de init do PostgreSQL também cria o banco `wagering_test`, usado pelos testes.
2. `setup`, um job único e idempotente que roda `bun run db:migrate && bun run sqs:setup`: aplica as migrations e cria as filas `wager-transactions.fifo`, `wager-transactions-dlq.fifo` (com redrive policy de 5 recebimentos) e `wagering-events.fifo`.
3. `app-1`, `app-2` e `app-3`, três instâncias da mesma imagem com todos os papéis (`APP_ROLES=api,consumer,outbox,pending-reference`), nas portas `3001`, `3002` e `3003`.

Verificando:

```bash
docker compose ps
curl -s localhost:3001/health/live    # {"status":"ok"}
curl -s localhost:3001/health/ready   # {"status":"ok","checks":{...}}
```

Parando e limpando:

```bash
docker compose down        # mantém o volume do PostgreSQL
docker compose down -v     # remove também os dados
```

## Rodando as 3 instâncias

O `docker compose up` acima já roda as três instâncias contra o mesmo PostgreSQL e as mesmas filas. Cada uma é um serviço explícito (e não `--scale`), o que dá portas fixas e permite derrubar uma instância pelo nome:

```bash
docker compose logs -f app-2      # logs JSON de uma instância
docker compose kill app-2         # simula a queda de uma instância
docker compose start app-2        # traz de volta
```

Os papéis de cada processo vêm de `APP_ROLES` (lista separada por vírgulas). Em produção, a mesma imagem pode ser implantada por papel, por exemplo 3 réplicas `api` e 2 réplicas `consumer`, apenas mudando essa variável.

Para rodar uma instância fora do Docker, com `postgres` e `sqs` do Compose no ar:

```bash
bun install
DATABASE_URL=postgres://wagering:wagering@localhost:5432/wagering PORT=3000 bun run dev
```

## Exemplos de uso da API

Criar uma carteira com saldo inicial (gera a transação interna `OPENING` e o lançamento `CREDIT` na mesma transação SQL):

```bash
curl -s -X POST localhost:3001/wallets \
  -H 'Content-Type: application/json' \
  -d '{"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","initialBalance":{"amount":"1000.00","currency":"BRL"}}'
```

Submeter uma aposta (o header `Idempotency-Key` é obrigatório; valores monetários são sempre strings com 2 casas decimais):

```bash
curl -s -X POST localhost:3001/wagering/transactions \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: provider-a:transaction-123' \
  -d '{"providerId":"provider-a","externalTransactionId":"transaction-123","playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","walletId":"<walletId>","roundId":"round-987","gameId":"fortune-chimp","kind":"BET","money":{"amount":"25.00","currency":"BRL"}}'
```

Reenviar exatamente a mesma requisição devolve a mesma resposta com `"idempotentReplay": true`. A mesma chave com um payload diferente devolve `409 IDEMPOTENCY_KEY_CONFLICT`.

Consultas e reconciliação:

```bash
curl -s localhost:3001/wallets/<walletId>
curl -s 'localhost:3001/wallets/<walletId>/ledger?limit=50'
curl -s localhost:3001/wagering/transactions/<transactionId>
curl -s localhost:3001/providers/provider-a/wagering/transactions/transaction-123
curl -s -X POST localhost:3001/wallets/<walletId>/reconciliation
curl -s localhost:3001/metrics
```

O mapeamento de status HTTP e os códigos de falha estão em `ARCHITECTURE.md`.

## Reproduzindo o cenário obrigatório (seção 8)

Saldo inicial `100.00 BRL` e duas apostas de `80.00 BRL` disparadas ao mesmo tempo, cada uma em uma instância diferente:

```bash
PLAYER=$(uuidgen | tr 'A-Z' 'a-z')
WALLET=$(curl -s -X POST localhost:3001/wallets -H 'Content-Type: application/json' \
  -d "{\"playerId\":\"$PLAYER\",\"initialBalance\":{\"amount\":\"100.00\",\"currency\":\"BRL\"}}" | jq -r .id)
RUN=$(date +%s)

bet() { # $1 = porta, $2 = id externo
  curl -s -w ' HTTP %{http_code}\n' -X POST "localhost:$1/wagering/transactions" \
    -H 'Content-Type: application/json' -H "Idempotency-Key: provider-a:$2" \
    -d "{\"providerId\":\"provider-a\",\"externalTransactionId\":\"$2\",\"playerId\":\"$PLAYER\",\"walletId\":\"$WALLET\",\"roundId\":\"round-$RUN\",\"gameId\":\"fortune-chimp\",\"kind\":\"BET\",\"money\":{\"amount\":\"80.00\",\"currency\":\"BRL\"}}"
}

bet 3001 "bet-a-$RUN" & bet 3002 "bet-b-$RUN" & wait

curl -s "localhost:3001/wallets/$WALLET" | jq .balance
curl -s "localhost:3003/wallets/$WALLET/ledger" | jq '[.items[] | select(.direction == "DEBIT")] | length'
```

Resultado esperado: uma resposta `201` com `"status":"PROCESSED"` e outra `422` com `"status":"REJECTED"` e `"failureCode":"INSUFFICIENT_FUNDS"`; saldo final `{"amount":"20.00","currency":"BRL"}`; exatamente `1` lançamento de débito. Repetir as duas chamadas `bet` com os mesmos ids devolve as mesmas respostas com `"idempotentReplay":true` e não muda o saldo nem o ledger.

O mesmo cenário é verificado automaticamente em `test/integration/wagering/mandatory-scenario.test.ts` (em processo, com requisições paralelas reais contra o PostgreSQL). A versão com 3 processos (T-C2 em `docs/spec.md`) faz parte da prova de concorrência (`bun run test:concurrency`).

## Scripts

| Script | O que faz |
|---|---|
| `bun run dev` | Sobe a aplicação com recarga automática (`bun --watch src/main.ts`). |
| `bun run start` | Sobe a aplicação (`bun src/main.ts`). |
| `bun run typecheck` | Checagem de tipos com `tsc --noEmit` (o Bun executa o TypeScript direto; o `tsc` só valida). |
| `bun run lint` | Lint e verificação de formatação com Biome. |
| `bun run format` | Formata o código com Biome. |
| `bun run check` | `typecheck` + `lint` + testes de unidade. É o portão de qualidade local. |
| `bun run db:migrate` | Aplica as migrations pendentes (tudo ou nada). |
| `bun run db:rollback` | Reverte a última migration. |
| `bun run sqs:setup` | Cria as filas SQS de forma idempotente. |
| `bun run test:unit` | Testes de unidade, em paralelo. |
| `bun run test:integration` | Testes de integração contra PostgreSQL e MiniStack reais. |
| `bun run test:concurrency` | Prova de concorrência (pasta `test/concurrency`, T-C1 a T-C3). |
| `bun run test` | Unidade e integração. |

Os scripts que acessam infraestrutura leem a configuração do ambiente (`DATABASE_URL`, `SQS_ENDPOINT` etc.); a lista completa de variáveis, com valores padrão, está na seção 3.19 de `docs/spec.md` e é validada com Zod na inicialização.

## Testes

Instale as dependências uma vez com `bun install`.

### Unidade

```bash
bun run test:unit
```

Não dependem de infraestrutura: domínio (`Money`, `Wallet`, `WagerTransaction`, regras de cada tipo de transação, eventos), hash do payload, configuração, logger, borda HTTP e um teste de arquitetura que barra imports proibidos entre camadas.

### Integração

```bash
docker compose up -d postgres sqs
bun run test:integration
```

Rodam contra o PostgreSQL e o MiniStack do Compose, sem mocks de `pg`, MikroORM ou do cliente SQS. O preload aplica as migrations no banco `wagering_test` (em `localhost:5432`). Cada teste cria suas próprias carteiras, jogadores e provedores, então nada é truncado entre execuções. Para usar outro banco, defina `TEST_DATABASE_URL`. A cobertura inclui migrations e constraints, provisionamento das filas, atomicidade de carteira, ledger e outbox, idempotência, a API HTTP, reconciliação, o cenário obrigatório, deduplicação do inbox, retry e DLQ do consumidor, desligamento gracioso, o publicador do outbox e o retentador de `PENDING_REFERENCE`.

### Concorrência

```bash
docker compose up -d postgres sqs
bun run test:concurrency
```

Cobre, com 3 processos reais da aplicação, T-C1 (a mesma aposta 50 vezes em paralelo), T-C2 (o cenário obrigatório) e T-C3 (carteiras distintas em paralelo). Os demais cenários da especificação (worker morto entre o commit e o ack, dois publicadores no mesmo outbox, `REFUND`/`ROLLBACK` antes da referência via SQS e reinício com prova de consistência) foram cortados; ver Limitações conhecidas em `ARCHITECTURE.md`.

## Usando LocalStack no lugar do MiniStack

O código fala com qualquer endpoint compatível com SQS. Para trocar, substitua o serviço `sqs` do `docker-compose.yml` pela imagem do LocalStack, exponha a porta `4566` e informe `LOCALSTACK_AUTH_TOKEN` (exigido pelo LocalStack desde a versão 2026.03). `SQS_ENDPOINT` continua `http://sqs:4566` dentro do Compose e `http://localhost:4566` fora dele. Apenas o MiniStack é usado nos testes.

## Solução de problemas

| Sintoma | Causa provável e solução |
|---|---|
| `Bind for 0.0.0.0:5432 failed: port is already allocated` (ou `4566`, `3001` a `3003`) | Outro processo usa a porta. Pare-o ou ajuste o mapeamento `ports` no `docker-compose.yml`. Se mudar a porta do PostgreSQL, ajuste também `TEST_DATABASE_URL` e `DATABASE_URL` ao rodar testes e scripts fora do Compose. |
| Testes de integração falham com `database "wagering_test" does not exist` | O script de init só roda quando o volume do PostgreSQL é criado. Se o volume já existia, recrie-o com `docker compose down -v && docker compose up -d`, ou crie o banco: `docker compose exec postgres createdb -U wagering wagering_test`. |
| Testes de integração falham com `ECONNREFUSED` | `postgres` ou `sqs` não estão no ar ou ainda não estão saudáveis. Confira com `docker compose ps` e aguarde `healthy`. |
| `app-*` não sobe e `setup` aparece como `exited (1)` | A migration ou a criação das filas falhou. Veja `docker compose logs setup`. O job é idempotente: corrija a causa e rode `docker compose up -d` de novo. |
| A aplicação encerra logo ao iniciar com erro de configuração | A configuração é validada com Zod e o processo sai com código diferente de zero mostrando a variável inválida. Corrija a variável indicada no log. |
| `POST /wagering/transactions` responde `400` com um valor como `25` ou `25.5` | Valores monetários são strings com exatamente 2 casas decimais (`"25.00"`). Números JSON também são recusados. |
| `POST /wallets` responde `409 WALLET_ALREADY_EXISTS` | Já existe uma carteira para esse `playerId` e moeda. `details.walletId` traz o id existente. |
| Respostas `503` com `Retry-After` | Falha transitória de infraestrutura (banco indisponível, timeout de lock). Reenvie com a mesma `Idempotency-Key`: o reenvio é seguro. |
| `docker compose stop` demora até 30 s | Intencional: as instâncias têm `stop_grace_period: 30s` para concluir mensagens em andamento no desligamento gracioso. |

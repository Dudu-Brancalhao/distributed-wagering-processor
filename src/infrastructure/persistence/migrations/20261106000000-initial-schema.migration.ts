import { Migration } from "@mikro-orm/migrations";

/** The complete schema of spec 3.10: tables, constraints, indexes and guard triggers. */
const UP_SQL = `
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
`;

/** Tables in reverse dependency order (their triggers go with them), then the trigger functions. */
const DOWN_SQL = `
DROP TABLE outbox_messages;
DROP TABLE inbox_messages;
DROP TABLE wallet_ledger_entries;
DROP TABLE wager_transactions;
DROP TABLE wallets;
DROP FUNCTION assert_ledger_entry_applied_to_wallet();
DROP FUNCTION assert_balance_change_has_ledger_entry();
DROP FUNCTION guard_wager_transaction_update();
DROP FUNCTION guard_wallet_update();
DROP FUNCTION forbid_mutation();
`;

export class InitialSchemaMigration extends Migration {
  override up(): void {
    this.addSql(UP_SQL);
  }

  override down(): void {
    this.addSql(DOWN_SQL);
  }
}

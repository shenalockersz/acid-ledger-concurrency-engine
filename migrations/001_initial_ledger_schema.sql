-- 001_initial_ledger_schema.sql
-- Double-entry ledger tables, database-enforced invariants, append-only auditability, and idempotency keys.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE,
  currency CHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  account_type TEXT NOT NULL CHECK (account_type IN ('USER', 'SYSTEM', 'ESCROW')),
  balance BIGINT NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  seq BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_non_negative_balance CHECK (balance >= 0 OR account_type = 'SYSTEM')
);

CREATE TABLE journal_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reference_id TEXT UNIQUE,
  currency CHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'POSTED' CHECK (status IN ('POSTED', 'REVERSED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE ledger_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id UUID NOT NULL REFERENCES journal_transactions(id),
  account_id UUID NOT NULL REFERENCES accounts(id),
  direction TEXT NOT NULL CHECK (direction IN ('DEBIT', 'CREDIT')),
  amount BIGINT NOT NULL CHECK (amount > 0),
  account_seq BIGINT NOT NULL CHECK (account_seq > 0),
  balance_after BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_account_seq UNIQUE (account_id, account_seq)
);

CREATE INDEX idx_ledger_entries_tx_id ON ledger_entries (transaction_id);
CREATE INDEX idx_ledger_entries_account_created ON ledger_entries (account_id, created_at DESC);

-- Deferred constraint trigger verifying every journal transaction balances (SUM(DEBIT) == SUM(CREDIT))
-- and matches entry account currencies before COMMIT.
CREATE OR REPLACE FUNCTION enforce_balanced_journal_transaction()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  entry_count INTEGER;
  debit_total BIGINT;
  credit_total BIGINT;
  mismatch_count INTEGER;
BEGIN
  SELECT
    COUNT(*),
    COALESCE(SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE 0 END), 0)
  INTO entry_count, debit_total, credit_total
  FROM ledger_entries
  WHERE transaction_id = NEW.id;

  IF entry_count < 2 THEN
    RAISE EXCEPTION 'Journal transaction % must contain at least 2 ledger entries (found %)', NEW.id, entry_count;
  END IF;

  IF debit_total <= 0 OR debit_total <> credit_total THEN
    RAISE EXCEPTION 'Unbalanced journal transaction %: debits (%) <> credits (%)', NEW.id, debit_total, credit_total;
  END IF;

  SELECT COUNT(*)
  INTO mismatch_count
  FROM ledger_entries le
  JOIN accounts a ON a.id = le.account_id
  WHERE le.transaction_id = NEW.id
    AND a.currency <> NEW.currency;

  IF mismatch_count > 0 THEN
    RAISE EXCEPTION 'Currency mismatch detected across entries for journal transaction %', NEW.id;
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER trg_enforce_balanced_tx
AFTER INSERT ON journal_transactions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION enforce_balanced_journal_transaction();

-- Append-only guard for ledger_entries: corrections must be posted as reversing journal transactions.
CREATE OR REPLACE FUNCTION prevent_ledger_entry_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'ledger_entries is append-only; % operations are prohibited', TG_OP;
END;
$$;

CREATE TRIGGER trg_prevent_ledger_entry_mutation
BEFORE UPDATE OR DELETE ON ledger_entries
FOR EACH ROW
EXECUTE FUNCTION prevent_ledger_entry_mutation();

CREATE TABLE idempotency_keys (
  tenant_id TEXT NOT NULL,
  route TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('IN_PROGRESS', 'COMPLETED', 'FAILED')),
  response_status INTEGER,
  response_body JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, route, idempotency_key)
);

-- Least-privilege grants for runtime application role when present.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ledger_app') THEN
    GRANT SELECT, INSERT, UPDATE ON accounts, journal_transactions, idempotency_keys TO ledger_app;
    GRANT SELECT, INSERT ON ledger_entries TO ledger_app;
    REVOKE UPDATE, DELETE, TRUNCATE ON ledger_entries FROM ledger_app;
  END IF;
END
$$;

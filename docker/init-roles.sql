-- Creates a least-privilege application role used by the API at runtime.
-- Object-level permissions (notably omitting UPDATE/DELETE/TRUNCATE on ledger_entries)
-- are granted by schema migrations after tables are created.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ledger_app') THEN
    CREATE ROLE ledger_app WITH LOGIN PASSWORD 'ledger_app_dev';
  END IF;
END
$$;

GRANT CONNECT ON DATABASE acid_ledger TO ledger_app;
GRANT USAGE ON SCHEMA public TO ledger_app;

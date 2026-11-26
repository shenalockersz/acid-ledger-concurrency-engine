# ADR 003: Atomic Idempotency Keys for Retry-Safe Transfers

## Context
Network timeouts and mobile retries frequently cause clients to submit duplicate `POST /api/transfers` requests. Relying only on a `SELECT` check before inserting creates a time-of-check to time-of-use (TOCTOU) race where two concurrent retries both pass the check and double-debit the account.

## Decision
Use a PostgreSQL `idempotency_keys` table keyed by `(tenant_id, route, idempotency_key)` with canonical SHA-256 request payload hashing:
1. Reserve ownership atomically with `INSERT ... ON CONFLICT DO NOTHING RETURNING status`.
2. Reject identical keys accompanied by a different canonical payload hash with `422 Unprocessable Entity` (`IDEMPOTENCY_PAYLOAD_MISMATCH`).
3. Reject concurrent in-flight duplicates (`IN_PROGRESS`) with `409 Conflict` (`IDEMPOTENCY_IN_PROGRESS`).
4. Persist `COMPLETED` responses (including deterministic `4xx` domain rejections) as JSONB for exact replay (`X-Idempotency-Replayed: true`), while marking unexpected `5xx` failures `FAILED` so clients can safely reclaim and retry with the same key.

## Alternatives Considered
- **Redis-only `SET NX` idempotency cache:** Fast, but introduces dual-write inconsistency if Redis drops a key or expires before a delayed client retry while the PostgreSQL ledger transfer committed.

## Consequences
- Idempotency state shares the same PostgreSQL availability domain as ledger transactions with zero dual-write drift.
- In production, old `idempotency_keys` rows should be pruned on a scheduled retention window (e.g., 24-72 hours).

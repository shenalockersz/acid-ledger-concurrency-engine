# ADR 001: Integer Minor Units and Database-Enforced Double-Entry Invariants

## Context
Financial ledgers built with IEEE-754 floating-point columns accumulate rounding drift, while application-only balance checks can be bypassed by bugs, ad-hoc scripts, or concurrent writes.

## Decision
1. Store all monetary balances and entry amounts as signed `BIGINT` minor units (e.g., cents for `USD`), disallowing floating-point arithmetic in PostgreSQL and TypeScript (`bigint`).
2. Model every balance change as a `journal_transactions` record paired with balanced `DEBIT` and `CREDIT` rows in `ledger_entries`.
3. Enforce `SUM(DEBIT) == SUM(CREDIT)`, minimum two entries per transaction, and currency consistency in PostgreSQL using a `DEFERRABLE INITIALLY DEFERRED` constraint trigger (`trg_enforce_balanced_tx`) evaluated at `COMMIT`.
4. Enforce append-only immutability on `ledger_entries` using both a `BEFORE UPDATE OR DELETE` trigger (`trg_prevent_ledger_entry_mutation`) and least-privilege `ledger_app` role grants.

## Alternatives Considered
- **Application-level balance checks only:** Simpler, but cannot prevent unbalanced partial writes from direct SQL scripts or future services.
- **`NUMERIC(18,4)` columns:** Useful for multi-decimal FX rates, but unnecessary overhead for single-currency minor-unit wallet transfers.

## Consequences
- Every correction must be recorded as an explicit reversing journal transaction rather than an in-place `UPDATE` or `DELETE`.
- Application code must convert `BIGINT` values via `BigInt(...)` and serialize to strings in JSON payloads.

# ADR 002: Pessimistic Row Locking vs. Optimistic Concurrency Control

## Context
Hot accounts (such as a central treasury, merchant settlement wallet, or shared promo pool) receive simultaneous concurrent transfers. Choosing a single locking model blindly either stalls low-contention workloads or causes excessive retry failures under heavy contention.

## Decision
Implement both strategies behind a shared `TransferStrategy` interface (`TransferService`):
1. **Pessimistic Locking (`SELECT ... FOR UPDATE`, default):** Acquires row locks in deterministic ascending account ID order (`ORDER BY id ASC`) to prevent bidirectional circular deadlocks (`A -> B` vs. `B -> A`).
2. **Optimistic Concurrency Control (OCC):** Reads accounts without locking, applies compare-and-swap updates (`WHERE id = $1 AND version = $4`) in ascending ID order, and retries stale-version conflicts using bounded exponential backoff with jitter.

## Alternatives Considered
- **`SERIALIZABLE` isolation across all transfers:** Strongest guarantee, but triggers higher serialization abort rates (`40001`) requiring blanket retry wrappers on every query.
- **OCC only:** Performs well when accounts rarely collide, but degrades under 50-way single-wallet contention where 49 of 50 concurrent readers observe stale versions.

## Consequences
- Pessimistic locking with ordered locks delivers deterministic zero-deadlock completion on hot accounts, trading sequential lock wait time for zero conflict retries.
- OCC excels on low-contention transfers while exposing measurable conflict rates when contended via `npm run bench:contention`.

import { Pool, PoolClient } from "pg";
import {
  calculatePercentile,
  summarizeBenchmarkRun,
} from "../../src/benchmarks/contention-benchmark";
import {
  DuplicateReferenceError,
  InsufficientFundsError,
  OptimisticLockConflictError,
} from "../../src/domain/errors";
import { OptimisticTransferStrategy } from "../../src/ledger/optimistic-transfer.strategy";
import { TransferService } from "../../src/ledger/transfer.service";

function makeAccountRow(overrides: {
  id: string;
  code: string;
  currency?: string;
  account_type?: "USER" | "SYSTEM" | "ESCROW";
  balance: string;
  version?: number;
  seq?: string;
}) {
  return {
    id: overrides.id,
    code: overrides.code,
    currency: overrides.currency ?? "USD",
    account_type: overrides.account_type ?? "USER",
    balance: overrides.balance,
    version: overrides.version ?? 1,
    seq: overrides.seq ?? "0",
    created_at: new Date("2026-11-25T10:00:00Z"),
    updated_at: new Date("2026-11-25T10:00:00Z"),
  };
}

function createSequenceMockPool(
  handler: (text: string, values: unknown[] | undefined, callCount: number) => unknown
): { pool: Pool; queries: Array<{ text: string; values?: unknown[] }> } {
  const queries: Array<{ text: string; values?: unknown[] }> = [];
  let attemptCount = 0;

  const client = {
    query: jest.fn(async (text: string, values?: unknown[]) => {
      const trimmed = text.trim();
      if (trimmed.startsWith("BEGIN")) {
        attemptCount += 1;
      }
      queries.push({ text: trimmed, values });
      return handler(trimmed, values, attemptCount);
    }),
    release: jest.fn(),
  } as unknown as PoolClient;

  const pool = {
    connect: jest.fn(async () => client),
  } as unknown as Pool;

  return { pool, queries };
}

describe("OptimisticTransferStrategy", () => {
  const idA = "11111111-1111-1111-1111-111111111111";
  const idB = "22222222-2222-2222-2222-222222222222";

  it("commits on first attempt when both CAS version checks succeed", async () => {
    const { pool, queries } = createSequenceMockPool((text) => {
      if (text.includes("FROM accounts")) {
        return {
          rows: [
            makeAccountRow({ id: idA, code: "A", balance: "5000", version: 3, seq: "2" }),
            makeAccountRow({ id: idB, code: "B", balance: "1000", version: 7, seq: "5" }),
          ],
        };
      }
      if (text.includes("UPDATE accounts")) {
        return { rowCount: 1, rows: [] };
      }
      if (text.includes("INSERT INTO journal_transactions")) {
        return { rows: [{ id: "tx-occ-1", created_at: new Date("2026-11-25T14:00:00Z") }] };
      }
      return { rowCount: 2, rows: [] };
    });

    const sleepSpy = jest.fn(async () => undefined);
    const strategy = new OptimisticTransferStrategy(pool, { sleep: sleepSpy });

    const res = await strategy.transfer({
      fromAccountId: idB,
      toAccountId: idA,
      amount: 400n,
      currency: "USD",
      description: "CAS transfer",
    });

    expect(res.strategy).toBe("optimistic");
    expect(res.attempts).toBe(1);
    expect(res.fromBalanceAfter).toBe(600n);
    expect(res.toBalanceAfter).toBe(5400n);
    expect(sleepSpy).not.toHaveBeenCalled();

    const updates = queries.filter((q) => q.text.includes("UPDATE accounts"));
    expect(updates).toHaveLength(2);
    expect(updates[0]?.values).toEqual([idA, "5400", "3", 3]);
    expect(updates[1]?.values).toEqual([idB, "600", "6", 7]);
  });

  it("retries with exponential backoff on stale version and succeeds on attempt 2", async () => {
    const { pool, queries } = createSequenceMockPool((text, _values, attempt) => {
      if (text.includes("FROM accounts")) {
        return {
          rows: [
            makeAccountRow({
              id: idA,
              code: "A",
              balance: "5000",
              version: attempt === 1 ? 1 : 2,
              seq: attempt === 1 ? "0" : "1",
            }),
            makeAccountRow({ id: idB, code: "B", balance: "1000", version: 1, seq: "0" }),
          ],
        };
      }
      if (text.includes("UPDATE accounts")) {
        return { rowCount: attempt === 1 ? 0 : 1, rows: [] };
      }
      if (text.includes("INSERT INTO journal_transactions")) {
        return { rows: [{ id: "tx-occ-2", created_at: new Date("2026-11-25T14:00:00Z") }] };
      }
      return { rowCount: 2, rows: [] };
    });

    const sleepSpy = jest.fn(async () => undefined);
    const strategy = new OptimisticTransferStrategy(pool, {
      maxRetries: 3,
      baseBackoffMs: 10,
      sleep: sleepSpy,
      random: () => 0.5,
    });

    const res = await strategy.transfer({
      fromAccountId: idA,
      toAccountId: idB,
      amount: 500n,
      currency: "USD",
      description: "Retry after CAS conflict",
    });

    expect(res.attempts).toBe(2);
    expect(sleepSpy).toHaveBeenCalledTimes(1);
    expect(queries.filter((q) => q.text === "ROLLBACK")).toHaveLength(1);
    expect(queries.filter((q) => q.text === "COMMIT")).toHaveLength(1);
  });

  it("throws OptimisticLockConflictError after maxRetries are exhausted", async () => {
    const { pool } = createSequenceMockPool((text) => {
      if (text.includes("FROM accounts")) {
        return {
          rows: [
            makeAccountRow({ id: idA, code: "A", balance: "5000", version: 1 }),
            makeAccountRow({ id: idB, code: "B", balance: "1000", version: 1 }),
          ],
        };
      }
      if (text.includes("UPDATE accounts")) {
        return { rowCount: 0, rows: [] };
      }
      return { rows: [] };
    });

    const sleepSpy = jest.fn(async () => undefined);
    const strategy = new OptimisticTransferStrategy(pool, {
      maxRetries: 2,
      sleep: sleepSpy,
    });

    await expect(
      strategy.transfer({
        fromAccountId: idA,
        toAccountId: idB,
        amount: 100n,
        currency: "USD",
        description: "Persistent conflict",
      })
    ).rejects.toThrow(OptimisticLockConflictError);

    expect(sleepSpy).toHaveBeenCalledTimes(2);
  });

  it("does not retry non-conflict errors such as InsufficientFundsError or DuplicateReferenceError", async () => {
    const fundsMock = createSequenceMockPool((text) => {
      if (text.includes("FROM accounts")) {
        return {
          rows: [
            makeAccountRow({ id: idA, code: "A", balance: "50", version: 1 }),
            makeAccountRow({ id: idB, code: "B", balance: "100", version: 1 }),
          ],
        };
      }
      return { rows: [] };
    });

    const sleepSpy = jest.fn(async () => undefined);
    await expect(
      new OptimisticTransferStrategy(fundsMock.pool, { maxRetries: 5, sleep: sleepSpy }).transfer({
        fromAccountId: idA,
        toAccountId: idB,
        amount: 200n,
        currency: "USD",
        description: "No retry on overdraft",
      })
    ).rejects.toThrow(InsufficientFundsError);
    expect(sleepSpy).not.toHaveBeenCalled();

    const dupMock = createSequenceMockPool((text) => {
      if (text.includes("FROM accounts")) {
        return {
          rows: [
            makeAccountRow({ id: idA, code: "A", balance: "500", version: 1 }),
            makeAccountRow({ id: idB, code: "B", balance: "100", version: 1 }),
          ],
        };
      }
      if (text.includes("UPDATE accounts")) {
        return { rowCount: 1, rows: [] };
      }
      if (text.includes("INSERT INTO journal_transactions")) {
        const err = new Error("duplicate") as Error & { code: string };
        err.code = "23505";
        throw err;
      }
      return { rows: [] };
    });

    await expect(
      new OptimisticTransferStrategy(dupMock.pool, { maxRetries: 5, sleep: sleepSpy }).transfer({
        fromAccountId: idA,
        toAccountId: idB,
        amount: 100n,
        currency: "USD",
        description: "No retry on duplicate ref",
        referenceId: "ref-dup",
      })
    ).rejects.toThrow(DuplicateReferenceError);
    expect(sleepSpy).not.toHaveBeenCalled();
  });
});

describe("TransferService and benchmark summary helpers", () => {
  const idA = "11111111-1111-1111-1111-111111111111";
  const idB = "22222222-2222-2222-2222-222222222222";

  it("routes requests to pessimistic or optimistic strategy cleanly", async () => {
    const { pool } = createSequenceMockPool((text) => {
      if (text.includes("FROM accounts")) {
        return {
          rows: [
            makeAccountRow({ id: idA, code: "A", balance: "1000", version: 1 }),
            makeAccountRow({ id: idB, code: "B", balance: "1000", version: 1 }),
          ],
        };
      }
      if (text.includes("UPDATE accounts")) {
        return { rowCount: 1, rows: [] };
      }
      if (text.includes("INSERT INTO journal_transactions")) {
        return { rows: [{ id: "tx-svc", created_at: new Date("2026-11-25T14:00:00Z") }] };
      }
      return { rowCount: 2, rows: [] };
    });

    const service = new TransferService(pool);
    const pRes = await service.transfer(
      { fromAccountId: idA, toAccountId: idB, amount: 100n, currency: "USD", description: "P" },
      "pessimistic"
    );
    const oRes = await service.transfer(
      { fromAccountId: idA, toAccountId: idB, amount: 100n, currency: "USD", description: "O" },
      "optimistic"
    );

    expect(pRes.strategy).toBe("pessimistic");
    expect(oRes.strategy).toBe("optimistic");
  });

  it("computes percentiles and benchmark summaries accurately", () => {
    expect(calculatePercentile([], 95)).toBe(0);
    expect(calculatePercentile([10, 20, 30, 40, 50], 50)).toBe(30);
    expect(calculatePercentile([10, 20, 30, 40, 50], 95)).toBe(50);

    const summary = summarizeBenchmarkRun({
      strategy: "optimistic",
      concurrency: 10,
      durationMs: 250,
      latenciesMs: [12, 40, 18, 25, 30, 15, 22, 60, 19, 33],
      attempts: [1, 2, 1, 3, 1, 1, 2, 4],
      succeeded: 8,
      conflicts: 2,
      failedOther: 0,
    });

    expect(summary.throughputRps).toBe(32);
    expect(summary.avgAttempts).toBe(1.88);
    expect(summary.p50Ms).toBe(22);
    expect(summary.p95Ms).toBe(60);
    expect(summary.maxMs).toBe(60);
  });
});

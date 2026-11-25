import { performance } from "node:perf_hooks";
import { loadEnv } from "../config/env";
import { closePool, createPool } from "../db/pool";
import { OptimisticLockConflictError } from "../domain/errors";
import { AccountRepository } from "../ledger/account.repository";
import { LockingStrategyName, TransferService } from "../ledger/transfer.service";

export interface BenchmarkRawMetrics {
  strategy: LockingStrategyName;
  concurrency: number;
  durationMs: number;
  latenciesMs: number[];
  attempts: number[];
  succeeded: number;
  conflicts: number;
  failedOther: number;
}

export interface BenchmarkSummary {
  strategy: LockingStrategyName;
  concurrency: number;
  durationMs: number;
  succeeded: number;
  conflicts: number;
  failedOther: number;
  throughputRps: number;
  avgAttempts: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
}

export function calculatePercentile(sortedValues: number[], percentile: number): number {
  if (sortedValues.length === 0) {
    return 0;
  }
  const bounded = Math.min(100, Math.max(0, percentile));
  const idx = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.ceil((bounded / 100) * sortedValues.length) - 1)
  );
  return Number((sortedValues[idx] ?? 0).toFixed(2));
}

export function summarizeBenchmarkRun(raw: BenchmarkRawMetrics): BenchmarkSummary {
  const sorted = [...raw.latenciesMs].sort((a, b) => a - b);
  const totalAttempts = raw.attempts.reduce((acc, v) => acc + v, 0);
  const throughputRps =
    raw.durationMs > 0 ? Number(((raw.succeeded / raw.durationMs) * 1000).toFixed(2)) : 0;
  const avgAttempts =
    raw.attempts.length > 0 ? Number((totalAttempts / raw.attempts.length).toFixed(2)) : 0;

  return {
    strategy: raw.strategy,
    concurrency: raw.concurrency,
    durationMs: Number(raw.durationMs.toFixed(2)),
    succeeded: raw.succeeded,
    conflicts: raw.conflicts,
    failedOther: raw.failedOther,
    throughputRps,
    avgAttempts,
    p50Ms: calculatePercentile(sorted, 50),
    p95Ms: calculatePercentile(sorted, 95),
    p99Ms: calculatePercentile(sorted, 99),
    maxMs: calculatePercentile(sorted, 100),
  };
}

async function runContentionBenchmark(): Promise<void> {
  const env = loadEnv();
  const pool = createPool(env.DATABASE_URL, 32);
  const repo = new AccountRepository(pool);
  const service = new TransferService(pool, { maxRetries: 5 });
  const concurrency = Number(process.env.BENCH_CONCURRENCY ?? "50");
  const transferAmount = 100n;

  try {
    const results: BenchmarkSummary[] = [];

    for (const strategy of ["pessimistic", "optimistic"] as const) {
      const suffix = `${strategy}_${Date.now()}`;
      const source = await repo.createAccount({
        code: `BENCH_SRC_${suffix}`,
        currency: "USD",
        accountType: "USER",
        initialBalance: BigInt(concurrency) * transferAmount,
      });
      const sink = await repo.createAccount({
        code: `BENCH_SINK_${suffix}`,
        currency: "USD",
        accountType: "USER",
        initialBalance: 0n,
      });

      const latenciesMs: number[] = [];
      const attempts: number[] = [];
      let succeeded = 0;
      let conflicts = 0;
      let failedOther = 0;

      const t0 = performance.now();
      await Promise.all(
        Array.from({ length: concurrency }, async (_, idx) => {
          const reqStart = performance.now();
          try {
            const res = await service.transfer(
              {
                fromAccountId: source.id,
                toAccountId: sink.id,
                amount: transferAmount,
                currency: "USD",
                description: `Benchmark ${strategy} #${idx}`,
              },
              strategy
            );
            succeeded += 1;
            attempts.push(res.attempts);
          } catch (err) {
            if (err instanceof OptimisticLockConflictError) {
              conflicts += 1;
            } else {
              failedOther += 1;
            }
          } finally {
            latenciesMs.push(performance.now() - reqStart);
          }
        })
      );
      const durationMs = performance.now() - t0;

      const afterSource = await repo.getById(source.id);
      const afterSink = await repo.getById(sink.id);
      const expectedMoved = BigInt(succeeded) * transferAmount;
      if (
        afterSource.balance !== BigInt(concurrency) * transferAmount - expectedMoved ||
        afterSink.balance !== expectedMoved
      ) {
        throw new Error(`Invariant mismatch after ${strategy} benchmark`);
      }

      results.push(
        summarizeBenchmarkRun({
          strategy,
          concurrency,
          durationMs,
          latenciesMs,
          attempts,
          succeeded,
          conflicts,
          failedOther,
        })
      );
    }

    console.table(results);
  } finally {
    await closePool(pool);
  }
}

if (require.main === module) {
  runContentionBenchmark().catch((err: unknown) => {
    console.error("Benchmark failed:", err);
    process.exit(1);
  });
}

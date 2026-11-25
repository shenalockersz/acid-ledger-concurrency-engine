export interface LatencySummary {
  durationMs: number;
  throughputRps: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
}

export function computePercentile(sortedValues: number[], percentile: number): number {
  if (sortedValues.length === 0) {
    return 0;
  }
  const bounded = Math.min(100, Math.max(0, percentile));
  const index = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.ceil((bounded / 100) * sortedValues.length) - 1)
  );
  return Number((sortedValues[index] ?? 0).toFixed(2));
}

export function summarizeLatencies(
  latenciesMs: number[],
  totalDurationMs: number,
  succeeded: number
): LatencySummary {
  const sorted = [...latenciesMs].sort((a, b) => a - b);
  const throughputRps =
    totalDurationMs > 0 ? Number(((succeeded / totalDurationMs) * 1000).toFixed(2)) : 0;

  return {
    durationMs: Number(totalDurationMs.toFixed(2)),
    throughputRps,
    p50Ms: computePercentile(sorted, 50),
    p95Ms: computePercentile(sorted, 95),
    p99Ms: computePercentile(sorted, 99),
    maxMs: computePercentile(sorted, 100),
  };
}

export function formatMinorUnits(amount: bigint, currency: string): string {
  const sign = amount < 0n ? "-" : "";
  const abs = amount < 0n ? -amount : amount;
  const whole = abs / 100n;
  const cents = (abs % 100n).toString().padStart(2, "0");
  const prefix = currency === "USD" ? "$" : `${currency} `;
  return `${sign}${prefix}${whole.toString()}.${cents}`;
}

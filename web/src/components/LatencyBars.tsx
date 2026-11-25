import { LatencyMetrics } from "../types";

interface LatencyBarsProps {
  metrics: LatencyMetrics;
  sampleLatenciesMs: number[];
}

export function LatencyBars({ metrics, sampleLatenciesMs }: LatencyBarsProps) {
  const scaleMax = Math.max(metrics.maxMs, 1);
  const rows = [
    { label: "P50", value: metrics.p50Ms, color: "bg-cyan-400" },
    { label: "P95", value: metrics.p95Ms, color: "bg-sky-400" },
    { label: "P99", value: metrics.p99Ms, color: "bg-indigo-400" },
    { label: "Max", value: metrics.maxMs, color: "bg-slate-400" },
  ];

  return (
    <div className="space-y-3 rounded-lg border border-slate-800 bg-slate-950/70 p-3.5">
      <div className="flex items-center justify-between text-xs text-slate-400">
        <span>Latency Distribution</span>
        <span className="font-mono tabular-nums text-slate-300">
          Total {metrics.durationMs.toFixed(1)} ms
        </span>
      </div>

      <div className="space-y-2">
        {rows.map((row) => {
          const widthPct = Math.max(4, Math.min(100, Math.round((row.value / scaleMax) * 100)));
          return (
            <div key={row.label} className="grid grid-cols-[40px_1fr_68px] items-center gap-2 text-xs">
              <span className="font-mono text-slate-400">{row.label}</span>
              <div className="h-2 overflow-hidden rounded-full bg-slate-800">
                <div
                  className={`h-full rounded-full ${row.color}`}
                  style={{ width: `${widthPct}%` }}
                />
              </div>
              <span className="text-right font-mono tabular-nums text-slate-200">
                {row.value.toFixed(1)} ms
              </span>
            </div>
          );
        })}
      </div>

      {sampleLatenciesMs.length > 0 && (
        <div className="pt-1">
          <div className="mb-1 text-[11px] text-slate-500">
            Per-request profile ({sampleLatenciesMs.length} concurrent calls)
          </div>
          <div className="flex h-8 items-end gap-0.5">
            {sampleLatenciesMs.slice(0, 60).map((ms, idx) => {
              const heightPct = Math.max(12, Math.round((ms / scaleMax) * 100));
              return (
                <div
                  key={idx}
                  title={`Req #${idx + 1}: ${ms.toFixed(1)} ms`}
                  className="flex-1 rounded-t bg-cyan-500/70 transition-all hover:bg-cyan-300"
                  style={{ height: `${heightPct}%` }}
                />
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

import { useCallback, useEffect, useState } from "react";
import { LatencyBars } from "./components/LatencyBars";
import {
  AccountEntriesResponse,
  AccountItem,
  AccountsResponse,
  DeadlockStressResponse,
  HealthResponse,
  LedgerEntryItem,
  RaceWithdrawalsResponse,
} from "./types";

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const data = (await res.json()) as T & { error?: { message?: string } };
  if (!res.ok) {
    throw new Error(data.error?.message ?? `Request failed (${res.status})`);
  }
  return data;
}

export default function App() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [accountsData, setAccountsData] = useState<AccountsResponse | null>(null);
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);
  const [entries, setEntries] = useState<LedgerEntryItem[]>([]);
  const [raceResult, setRaceResult] = useState<RaceWithdrawalsResponse | null>(null);
  const [deadlockResult, setDeadlockResult] = useState<DeadlockStressResponse | null>(null);
  const [runningRace, setRunningRace] = useState(false);
  const [runningDeadlock, setRunningDeadlock] = useState(false);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);

  const loadEntries = useCallback(async (accountId: string) => {
    try {
      const res = await fetchJson<AccountEntriesResponse>(`/api/accounts/${accountId}/entries`);
      setEntries(res.entries);
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : "Failed to load entries");
    }
  }, []);

  const refreshState = useCallback(async () => {
    setErrorBanner(null);
    try {
      const healthRes = await fetch("/api/health");
      const h = (await healthRes.json()) as HealthResponse;
      setHealth(h);

      if (h.db === "connected") {
        const accRes = await fetchJson<AccountsResponse>("/api/accounts");
        setAccountsData(accRes);
        const targetId =
          selectedAccountId && accRes.accounts.some((a) => a.id === selectedAccountId)
            ? selectedAccountId
            : (accRes.accounts[0]?.id ?? null);
        setSelectedAccountId(targetId);
        if (targetId) {
          await loadEntries(targetId);
        }
      }
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : "Cannot reach ledger API");
    }
  }, [loadEntries, selectedAccountId]);

  useEffect(() => {
    void refreshState();
  }, [refreshState]);

  const handleSelectAccount = async (acc: AccountItem) => {
    setSelectedAccountId(acc.id);
    await loadEntries(acc.id);
  };

  const handleRunRace = async () => {
    setRunningRace(true);
    setErrorBanner(null);
    try {
      const res = await fetchJson<RaceWithdrawalsResponse>("/api/lab/race-withdrawals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ concurrency: 50, initialBalance: 10000, withdrawalAmount: 1000 }),
      });
      setRaceResult(res);
      setSelectedAccountId(res.walletAccountId);
      await refreshState();
      await loadEntries(res.walletAccountId);
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : "Race withdrawal benchmark failed");
    } finally {
      setRunningRace(false);
    }
  };

  const handleRunDeadlock = async () => {
    setRunningDeadlock(true);
    setErrorBanner(null);
    try {
      const res = await fetchJson<DeadlockStressResponse>("/api/lab/deadlock-stress", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pairs: 20, amount: 100 }),
      });
      setDeadlockResult(res);
      setSelectedAccountId(res.accountAId);
      await refreshState();
      await loadEntries(res.accountAId);
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : "Deadlock stress benchmark failed");
    } finally {
      setRunningDeadlock(false);
    }
  };

  const dbConnected = health?.db === "connected";
  const selectedAccount =
    accountsData?.accounts.find((a) => a.id === selectedAccountId) ?? null;

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <div className="mx-auto max-w-6xl space-y-6 px-4 py-8 sm:px-6">
        <header className="flex flex-col justify-between gap-4 rounded-xl border border-slate-800 bg-slate-900/80 p-5 sm:flex-row sm:items-center">
          <div>
            <div className="flex flex-wrap items-center gap-2.5">
              <h1 className="text-xl font-semibold tracking-tight text-white">
                ACID Ledger Concurrency Lab
              </h1>
              <span className="rounded-full border border-cyan-500/30 bg-cyan-500/10 px-2.5 py-0.5 text-xs font-medium text-cyan-300">
                Pessimistic · SELECT FOR UPDATE (Ordered)
              </span>
            </div>
            <p className="mt-1 text-sm text-slate-400">
              Live PostgreSQL double-entry invariant verification, contention benchmarks, and immutable ledger inspection.
            </p>
          </div>

          <div className="flex items-center gap-3">
            <span
              className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium ${
                dbConnected
                  ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                  : "border-amber-500/30 bg-amber-500/10 text-amber-300"
              }`}
            >
              <span
                className={`h-2 w-2 rounded-full ${
                  dbConnected ? "bg-emerald-400" : "bg-amber-400"
                }`}
              />
              {dbConnected ? "PostgreSQL Connected" : "DB Offline"}
            </span>
            <button
              type="button"
              onClick={() => void refreshState()}
              className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-200 transition hover:bg-slate-700"
            >
              Refresh
            </button>
          </div>
        </header>

        {!dbConnected && (
          <div className="rounded-xl border border-amber-500/30 bg-amber-950/30 p-4 text-sm text-amber-200">
            <p className="font-medium">PostgreSQL container is not reachable yet.</p>
            <p className="mt-1 font-mono text-xs text-amber-300/90">
              docker compose up -d &amp;&amp; npm run migrate &amp;&amp; npm run seed
            </p>
          </div>
        )}

        {errorBanner && (
          <div className="rounded-xl border border-rose-500/40 bg-rose-950/40 p-3.5 text-sm text-rose-200">
            {errorBanner}
          </div>
        )}

        <section className="grid gap-5 lg:grid-cols-2">
          <div className="flex flex-col justify-between space-y-4 rounded-xl border border-slate-800 bg-slate-900/70 p-5">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-base font-semibold text-white">
                  50x Race Withdrawal Stress
                </h2>
                <p className="mt-1 text-xs text-slate-400">
                  Fires 50 simultaneous $10.00 withdrawals against a $100.00 wallet. Proves exact overdraft prevention under contention.
                </p>
              </div>
              <button
                type="button"
                disabled={!dbConnected || runningRace}
                onClick={() => void handleRunRace()}
                className="shrink-0 rounded-lg bg-cyan-500 px-3.5 py-2 text-xs font-semibold text-slate-950 transition hover:bg-cyan-400 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {runningRace ? "Running..." : "Run 50x Race"}
              </button>
            </div>

            {raceResult ? (
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
                  <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-3">
                    <div className="text-[11px] text-slate-400">Succeeded</div>
                    <div className="mt-0.5 font-mono text-lg font-semibold text-emerald-400">
                      {raceResult.succeeded}/{raceResult.expectedSucceeded}
                    </div>
                  </div>
                  <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-3">
                    <div className="text-[11px] text-slate-400">Rejected (409)</div>
                    <div className="mt-0.5 font-mono text-lg font-semibold text-amber-300">
                      {raceResult.rejectedInsufficientFunds}
                    </div>
                  </div>
                  <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-3">
                    <div className="text-[11px] text-slate-400">Final Balance</div>
                    <div className="mt-0.5 font-mono text-lg font-semibold text-white">
                      {raceResult.finalBalanceFormatted}
                    </div>
                  </div>
                  <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-3">
                    <div className="text-[11px] text-slate-400">Throughput</div>
                    <div className="mt-0.5 font-mono text-lg font-semibold text-cyan-300">
                      {raceResult.metrics.throughputRps} req/s
                    </div>
                  </div>
                </div>

                <LatencyBars
                  metrics={raceResult.metrics}
                  sampleLatenciesMs={raceResult.sampleLatenciesMs}
                />

                <div className="flex items-center justify-between text-xs">
                  <span className="text-slate-400">
                    Initial: {raceResult.initialBalanceFormatted} · Withdrawal: {raceResult.withdrawalAmountFormatted}
                  </span>
                  <span
                    className={`rounded-md px-2 py-0.5 font-mono font-medium ${
                      raceResult.invariantPassed
                        ? "bg-emerald-500/15 text-emerald-300"
                        : "bg-rose-500/15 text-rose-300"
                    }`}
                  >
                    {raceResult.invariantPassed ? "INVARIANT VERIFIED" : "INVARIANT FAILED"}
                  </span>
                </div>
              </div>
            ) : (
              <div className="rounded-lg border border-dashed border-slate-800 p-6 text-center text-xs text-slate-500">
                Click &quot;Run 50x Race&quot; to capture live PostgreSQL contention metrics.
              </div>
            )}
          </div>

          <div className="flex flex-col justify-between space-y-4 rounded-xl border border-slate-800 bg-slate-900/70 p-5">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-base font-semibold text-white">
                  40x Bidirectional Deadlock Stress
                </h2>
                <p className="mt-1 text-xs text-slate-400">
                  Fires 20 A-&gt;B and 20 B-&gt;A transfers simultaneously. Deterministic ascending lock order prevents circular deadlocks.
                </p>
              </div>
              <button
                type="button"
                disabled={!dbConnected || runningDeadlock}
                onClick={() => void handleRunDeadlock()}
                className="shrink-0 rounded-lg bg-indigo-500 px-3.5 py-2 text-xs font-semibold text-white transition hover:bg-indigo-400 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {runningDeadlock ? "Running..." : "Run 40x Bi-Dir"}
              </button>
            </div>

            {deadlockResult ? (
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
                  <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-3">
                    <div className="text-[11px] text-slate-400">Deadlocks</div>
                    <div className="mt-0.5 font-mono text-lg font-semibold text-emerald-400">
                      {deadlockResult.deadlocks}
                    </div>
                  </div>
                  <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-3">
                    <div className="text-[11px] text-slate-400">Succeeded</div>
                    <div className="mt-0.5 font-mono text-lg font-semibold text-white">
                      {deadlockResult.succeeded}/{deadlockResult.totalTransfers}
                    </div>
                  </div>
                  <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-3">
                    <div className="text-[11px] text-slate-400">Conserved Sum</div>
                    <div className="mt-0.5 font-mono text-lg font-semibold text-white">
                      {deadlockResult.conservedTotalFormatted}
                    </div>
                  </div>
                  <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-3">
                    <div className="text-[11px] text-slate-400">Throughput</div>
                    <div className="mt-0.5 font-mono text-lg font-semibold text-indigo-300">
                      {deadlockResult.metrics.throughputRps} req/s
                    </div>
                  </div>
                </div>

                <LatencyBars
                  metrics={deadlockResult.metrics}
                  sampleLatenciesMs={deadlockResult.sampleLatenciesMs}
                />

                <div className="flex items-center justify-between text-xs">
                  <span className="text-slate-400">
                    {deadlockResult.pairs} A-&gt;B + {deadlockResult.pairs} B-&gt;A concurrent pairs
                  </span>
                  <span
                    className={`rounded-md px-2 py-0.5 font-mono font-medium ${
                      deadlockResult.invariantPassed
                        ? "bg-emerald-500/15 text-emerald-300"
                        : "bg-rose-500/15 text-rose-300"
                    }`}
                  >
                    {deadlockResult.invariantPassed ? "ZERO DEADLOCKS" : "CHECK FAILED"}
                  </span>
                </div>
              </div>
            ) : (
              <div className="rounded-lg border border-dashed border-slate-800 p-6 text-center text-xs text-slate-500">
                Click &quot;Run 40x Bi-Dir&quot; to test ordered row locking under simultaneous bidirectional load.
              </div>
            )}
          </div>
        </section>

        <section className="grid gap-5 lg:grid-cols-5">
          <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-5 lg:col-span-2">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-base font-semibold text-white">Accounts</h2>
              {accountsData && (
                <span
                  className={`rounded-md px-2 py-0.5 font-mono text-[11px] ${
                    accountsData.invariants.balanced
                      ? "bg-emerald-500/15 text-emerald-300"
                      : "bg-amber-500/15 text-amber-300"
                  }`}
                >
                  Sum: {accountsData.invariants.globalBalanceFormatted}
                </span>
              )}
            </div>

            <div className="max-h-80 space-y-1.5 overflow-y-auto pr-1">
              {accountsData?.accounts.map((acc) => {
                const active = acc.id === selectedAccountId;
                return (
                  <button
                    key={acc.id}
                    type="button"
                    onClick={() => void handleSelectAccount(acc)}
                    className={`flex w-full items-center justify-between rounded-lg border px-3 py-2 text-left text-xs transition ${
                      active
                        ? "border-cyan-500/50 bg-cyan-500/10"
                        : "border-slate-800 bg-slate-950/60 hover:border-slate-700"
                    }`}
                  >
                    <div>
                      <div className="font-mono font-medium text-slate-100">{acc.code}</div>
                      <div className="text-[11px] text-slate-400">
                        {acc.accountType} · v{acc.version} · seq {acc.seq}
                      </div>
                    </div>
                    <div className="font-mono text-sm font-semibold tabular-nums text-white">
                      {acc.balanceFormatted}
                    </div>
                  </button>
                );
              })}

              {(!accountsData || accountsData.accounts.length === 0) && (
                <div className="rounded-lg border border-dashed border-slate-800 p-4 text-center text-xs text-slate-500">
                  No accounts loaded.
                </div>
              )}
            </div>
          </div>

          <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-5 lg:col-span-3">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-base font-semibold text-white">
                Append-Only Ledger Entries
              </h2>
              {selectedAccount && (
                <span className="font-mono text-xs text-slate-400">
                  {selectedAccount.code} ({entries.length} entries)
                </span>
              )}
            </div>

            <div className="max-h-80 overflow-x-auto overflow-y-auto">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-slate-800 text-slate-400">
                  <tr>
                    <th className="pb-2 pr-3 font-medium">Seq</th>
                    <th className="pb-2 pr-3 font-medium">Direction</th>
                    <th className="pb-2 pr-3 font-medium">Amount</th>
                    <th className="pb-2 pr-3 font-medium">Balance After</th>
                    <th className="pb-2 font-medium">Posted At</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/70 font-mono">
                  {entries.map((entry) => (
                    <tr key={entry.id} className="hover:bg-slate-950/50">
                      <td className="py-2 pr-3 text-slate-400">#{entry.accountSeq}</td>
                      <td className="py-2 pr-3">
                        <span
                          className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                            entry.direction === "CREDIT"
                              ? "bg-emerald-500/15 text-emerald-300"
                              : "bg-rose-500/15 text-rose-300"
                          }`}
                        >
                          {entry.direction}
                        </span>
                      </td>
                      <td className="py-2 pr-3 tabular-nums text-slate-100">
                        {entry.amountFormatted}
                      </td>
                      <td className="py-2 pr-3 tabular-nums text-slate-200">
                        {entry.balanceAfterFormatted}
                      </td>
                      <td className="py-2 text-slate-400">
                        {new Date(entry.createdAt).toLocaleTimeString()}
                      </td>
                    </tr>
                  ))}
                  {entries.length === 0 && (
                    <tr>
                      <td colSpan={5} className="py-6 text-center font-sans text-slate-500">
                        Select an account with transactions to inspect its immutable double-entry trail.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

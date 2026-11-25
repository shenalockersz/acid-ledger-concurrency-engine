export interface HealthResponse {
  status: "ok" | "degraded";
  db: "connected" | "unavailable";
  strategy: string;
  error?: string;
}

export interface AccountItem {
  id: string;
  code: string;
  currency: string;
  accountType: "USER" | "SYSTEM" | "ESCROW";
  balance: string;
  balanceFormatted: string;
  version: number;
  seq: string;
  createdAt: string;
  updatedAt: string;
}

export interface AccountsResponse {
  accounts: AccountItem[];
  invariants: {
    accountCount: number;
    globalBalanceSum: string;
    globalBalanceFormatted: string;
    balanced: boolean;
  };
}

export interface LedgerEntryItem {
  id: string;
  transactionId: string;
  accountId: string;
  direction: "DEBIT" | "CREDIT";
  amount: string;
  amountFormatted: string;
  accountSeq: string;
  balanceAfter: string;
  balanceAfterFormatted: string;
  createdAt: string;
}

export interface AccountEntriesResponse {
  account: AccountItem;
  entries: LedgerEntryItem[];
}

export interface LatencyMetrics {
  durationMs: number;
  throughputRps: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
}

export interface RaceWithdrawalsResponse {
  strategy: string;
  concurrency: number;
  initialBalanceFormatted: string;
  withdrawalAmountFormatted: string;
  succeeded: number;
  rejectedInsufficientFunds: number;
  failedOther: number;
  expectedSucceeded: number;
  finalBalanceFormatted: string;
  invariantPassed: boolean;
  walletAccountId: string;
  sinkAccountId: string;
  metrics: LatencyMetrics;
  sampleLatenciesMs: number[];
}

export interface DeadlockStressResponse {
  strategy: string;
  totalTransfers: number;
  pairs: number;
  succeeded: number;
  deadlocks: number;
  failedOther: number;
  conservedTotalFormatted: string;
  invariantPassed: boolean;
  accountAId: string;
  accountBId: string;
  metrics: LatencyMetrics;
  sampleLatenciesMs: number[];
}

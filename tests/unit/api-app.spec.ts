import http from "node:http";
import { AddressInfo } from "node:net";
import { Pool, PoolClient } from "pg";
import { createApp } from "../../src/api/app";
import { computePercentile, formatMinorUnits } from "../../src/api/metrics";

function makeAccountRow(overrides: {
  id: string;
  code: string;
  balance: string;
  seq?: string;
}) {
  return {
    id: overrides.id,
    code: overrides.code,
    currency: "USD",
    account_type: "USER" as const,
    balance: overrides.balance,
    version: 1,
    seq: overrides.seq ?? "0",
    created_at: new Date("2026-11-25T10:00:00Z"),
    updated_at: new Date("2026-11-25T10:00:00Z"),
  };
}

async function withServer(
  pool: Pool,
  fn: (baseUrl: string) => Promise<void>
): Promise<void> {
  const app = createApp(pool);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${addr.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("API metrics helpers", () => {
  it("computes percentiles and formats minor units cleanly", () => {
    expect(computePercentile([], 95)).toBe(0);
    expect(computePercentile([5, 10, 15, 20, 25], 50)).toBe(15);
    expect(computePercentile([5, 10, 15, 20, 25], 95)).toBe(25);
    expect(formatMinorUnits(10_000n, "USD")).toBe("$100.00");
    expect(formatMinorUnits(-5_050n, "USD")).toBe("-$50.50");
    expect(formatMinorUnits(125n, "EUR")).toBe("EUR 1.25");
  });
});

describe("Express ledger API", () => {
  const idA = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  const idB = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

  it("reports healthy DB status on GET /api/health", async () => {
    const pool = {
      query: jest.fn(async () => ({ rows: [{ "?column?": 1 }] })),
      connect: jest.fn(),
    } as unknown as Pool;

    await withServer(pool, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/health`);
      expect(res.status).toBe(200);
      const data = (await res.json()) as { status: string; db: string; strategy: string };
      expect(data).toEqual({ status: "ok", db: "connected", strategy: "pessimistic" });
    });
  });

  it("returns 400 on invalid transfer body and 409 on InsufficientFundsError", async () => {
    const client = {
      query: jest.fn(async (text: string) => {
        if (text.includes("FROM accounts")) {
          return {
            rows: [
              makeAccountRow({ id: idA, code: "A", balance: "100" }),
              makeAccountRow({ id: idB, code: "B", balance: "0" }),
            ],
          };
        }
        return { rows: [] };
      }),
      release: jest.fn(),
    } as unknown as PoolClient;

    const pool = {
      query: jest.fn(),
      connect: jest.fn(async () => client),
    } as unknown as Pool;

    await withServer(pool, async (baseUrl) => {
      const badRes = await fetch(`${baseUrl}/api/transfers`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fromAccountId: idA, toAccountId: idB, amount: -5 }),
      });
      expect(badRes.status).toBe(400);

      const overdraftRes = await fetch(`${baseUrl}/api/transfers`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fromAccountId: idA,
          toAccountId: idB,
          amount: "500",
          currency: "USD",
          description: "Overdraft check",
        }),
      });
      expect(overdraftRes.status).toBe(409);
      const body = (await overdraftRes.json()) as { error: { code: string } };
      expect(body.error.code).toBe("INSUFFICIENT_FUNDS");
    });
  });

  it("returns 201 and serialized bigint balances on successful transfer", async () => {
    const client = {
      query: jest.fn(async (text: string) => {
        if (text.includes("FROM accounts")) {
          return {
            rows: [
              makeAccountRow({ id: idA, code: "A", balance: "5000", seq: "1" }),
              makeAccountRow({ id: idB, code: "B", balance: "1000", seq: "0" }),
            ],
          };
        }
        if (text.includes("INSERT INTO journal_transactions")) {
          return { rows: [{ id: "tx-api-1", created_at: new Date("2026-11-25T15:00:00Z") }] };
        }
        return { rows: [] };
      }),
      release: jest.fn(),
    } as unknown as PoolClient;

    const pool = {
      query: jest.fn(),
      connect: jest.fn(async () => client),
    } as unknown as Pool;

    await withServer(pool, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/transfers`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fromAccountId: idA,
          toAccountId: idB,
          amount: "1500",
          currency: "USD",
          description: "API transfer test",
        }),
      });
      expect(res.status).toBe(201);
      const data = (await res.json()) as {
        transactionId: string;
        fromBalanceAfter: string;
        toBalanceAfter: string;
      };
      expect(data.transactionId).toBe("tx-api-1");
      expect(data.fromBalanceAfter).toBe("3500");
      expect(data.toBalanceAfter).toBe("2500");
    });
  });
});

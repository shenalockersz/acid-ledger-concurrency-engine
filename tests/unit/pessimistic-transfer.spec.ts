import { Pool, PoolClient } from "pg";
import {
  AccountNotFoundError,
  CurrencyMismatchError,
  DuplicateReferenceError,
  InsufficientFundsError,
  ValidationError,
} from "../../src/domain/errors";
import { PessimisticTransferStrategy } from "../../src/ledger/pessimistic-transfer.strategy";
import {
  sortAccountIdsForLocking,
  validateTransferInput,
} from "../../src/ledger/validation";

interface RecordedQuery {
  text: string;
  values?: unknown[];
}

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

function createMockPool(
  handler: (text: string, values?: unknown[]) => unknown
): { pool: Pool; queries: RecordedQuery[] } {
  const queries: RecordedQuery[] = [];
  const client = {
    query: jest.fn(async (text: string, values?: unknown[]) => {
      queries.push({ text: text.trim(), values });
      return handler(text.trim(), values);
    }),
    release: jest.fn(),
  } as unknown as PoolClient;

  const pool = {
    connect: jest.fn(async () => client),
  } as unknown as Pool;

  return { pool, queries };
}

describe("transfer validation and lock ordering", () => {
  it("produces identical lock order for bidirectional transfers", () => {
    const a = "11111111-1111-1111-1111-111111111111";
    const b = "99999999-9999-9999-9999-999999999999";
    expect(sortAccountIdsForLocking(a, b)).toEqual([a, b]);
    expect(sortAccountIdsForLocking(b, a)).toEqual([a, b]);
  });

  it("rejects non-positive amounts, self-transfers, invalid currency, and empty description", () => {
    expect(() =>
      validateTransferInput({
        fromAccountId: "a",
        toAccountId: "b",
        amount: 0n,
        currency: "USD",
        description: "test",
      })
    ).toThrow(ValidationError);

    expect(() =>
      validateTransferInput({
        fromAccountId: "a",
        toAccountId: "a",
        amount: 100n,
        currency: "USD",
        description: "test",
      })
    ).toThrow(ValidationError);

    expect(() =>
      validateTransferInput({
        fromAccountId: "a",
        toAccountId: "b",
        amount: 100n,
        currency: "usd",
        description: "test",
      })
    ).toThrow(ValidationError);

    expect(() =>
      validateTransferInput({
        fromAccountId: "a",
        toAccountId: "b",
        amount: 100n,
        currency: "USD",
        description: "   ",
      })
    ).toThrow(ValidationError);
  });
});

describe("PessimisticTransferStrategy", () => {
  const idA = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  const idB = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

  it("acquires ordered FOR UPDATE locks and posts balanced double-entry rows", async () => {
    const { pool, queries } = createMockPool((text) => {
      if (text.includes("FROM accounts")) {
        return {
          rows: [
            makeAccountRow({ id: idA, code: "USER_A", balance: "500", seq: "4" }),
            makeAccountRow({ id: idB, code: "USER_B", balance: "10000", seq: "1" }),
          ],
        };
      }
      if (text.includes("INSERT INTO journal_transactions")) {
        return {
          rows: [{ id: "tx-1", created_at: new Date("2026-11-25T12:00:00Z") }],
        };
      }
      return { rows: [] };
    });

    const strategy = new PessimisticTransferStrategy(pool);
    const result = await strategy.transfer({
      fromAccountId: idB,
      toAccountId: idA,
      amount: 2500n,
      currency: "USD",
      description: "Invoice settlement",
      referenceId: "ref-100",
    });

    expect(result.strategy).toBe("pessimistic");
    expect(result.attempts).toBe(1);
    expect(result.fromBalanceAfter).toBe(7500n);
    expect(result.toBalanceAfter).toBe(3000n);

    const lockQuery = queries.find((q) => q.text.includes("FOR UPDATE"));
    expect(lockQuery?.values).toEqual([idA, idB]);
    expect(lockQuery?.text).toContain("ORDER BY id ASC");

    const entriesInsert = queries.find((q) => q.text.includes("INSERT INTO ledger_entries"));
    expect(entriesInsert?.values).toEqual([
      "tx-1",
      idB,
      "2500",
      "2",
      "7500",
      idA,
      "5",
      "3000",
    ]);
    expect(queries.some((q) => q.text === "COMMIT")).toBe(true);
  });

  it("rejects overdraft on USER accounts and rolls back the transaction", async () => {
    const { pool, queries } = createMockPool((text) => {
      if (text.includes("FROM accounts")) {
        return {
          rows: [
            makeAccountRow({ id: idA, code: "USER_A", balance: "500" }),
            makeAccountRow({ id: idB, code: "USER_B", balance: "0" }),
          ],
        };
      }
      return { rows: [] };
    });

    const strategy = new PessimisticTransferStrategy(pool);
    await expect(
      strategy.transfer({
        fromAccountId: idA,
        toAccountId: idB,
        amount: 600n,
        currency: "USD",
        description: "Attempted overdraft",
      })
    ).rejects.toThrow(InsufficientFundsError);

    expect(queries.some((q) => q.text === "ROLLBACK")).toBe(true);
    expect(queries.some((q) => q.text === "COMMIT")).toBe(false);
  });

  it("allows negative balances on SYSTEM treasury accounts", async () => {
    const { pool } = createMockPool((text) => {
      if (text.includes("FROM accounts")) {
        return {
          rows: [
            makeAccountRow({
              id: idA,
              code: "SYSTEM_TREASURY",
              account_type: "SYSTEM",
              balance: "0",
            }),
            makeAccountRow({ id: idB, code: "USER_B", balance: "100" }),
          ],
        };
      }
      if (text.includes("INSERT INTO journal_transactions")) {
        return {
          rows: [{ id: "tx-sys-1", created_at: new Date("2026-11-25T12:00:00Z") }],
        };
      }
      return { rows: [] };
    });

    const strategy = new PessimisticTransferStrategy(pool);
    const result = await strategy.transfer({
      fromAccountId: idA,
      toAccountId: idB,
      amount: 5000n,
      currency: "USD",
      description: "Initial wallet funding",
    });

    expect(result.fromBalanceAfter).toBe(-5000n);
    expect(result.toBalanceAfter).toBe(5100n);
  });

  it("throws AccountNotFoundError and CurrencyMismatchError when invariants fail", async () => {
    const missingMock = createMockPool((text) => {
      if (text.includes("FROM accounts")) {
        return { rows: [makeAccountRow({ id: idA, code: "USER_A", balance: "500" })] };
      }
      return { rows: [] };
    });

    await expect(
      new PessimisticTransferStrategy(missingMock.pool).transfer({
        fromAccountId: idA,
        toAccountId: idB,
        amount: 100n,
        currency: "USD",
        description: "Missing target",
      })
    ).rejects.toThrow(AccountNotFoundError);

    const mismatchMock = createMockPool((text) => {
      if (text.includes("FROM accounts")) {
        return {
          rows: [
            makeAccountRow({ id: idA, code: "USER_A", currency: "USD", balance: "500" }),
            makeAccountRow({ id: idB, code: "USER_B", currency: "EUR", balance: "500" }),
          ],
        };
      }
      return { rows: [] };
    });

    await expect(
      new PessimisticTransferStrategy(mismatchMock.pool).transfer({
        fromAccountId: idA,
        toAccountId: idB,
        amount: 100n,
        currency: "USD",
        description: "FX mismatch",
      })
    ).rejects.toThrow(CurrencyMismatchError);
  });

  it("maps PostgreSQL unique violation 23505 on referenceId to DuplicateReferenceError", async () => {
    const { pool, queries } = createMockPool((text) => {
      if (text.includes("FROM accounts")) {
        return {
          rows: [
            makeAccountRow({ id: idA, code: "USER_A", balance: "1000" }),
            makeAccountRow({ id: idB, code: "USER_B", balance: "0" }),
          ],
        };
      }
      if (text.includes("INSERT INTO journal_transactions")) {
        const err = new Error("duplicate key value") as Error & { code: string };
        err.code = "23505";
        throw err;
      }
      return { rows: [] };
    });

    await expect(
      new PessimisticTransferStrategy(pool).transfer({
        fromAccountId: idA,
        toAccountId: idB,
        amount: 100n,
        currency: "USD",
        description: "Duplicate ref",
        referenceId: "dup-ref-1",
      })
    ).rejects.toThrow(DuplicateReferenceError);

    expect(queries.some((q) => q.text === "ROLLBACK")).toBe(true);
  });
});

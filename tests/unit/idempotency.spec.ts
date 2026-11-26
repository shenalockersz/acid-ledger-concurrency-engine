import http from "node:http";
import { AddressInfo } from "node:net";
import { Pool, PoolClient } from "pg";
import { createApp } from "../../src/api/app";
import {
  IdempotencyInProgressError,
  IdempotencyPayloadMismatchError,
  InsufficientFundsError,
} from "../../src/domain/errors";
import { canonicalize, hashRequestPayload } from "../../src/idempotency/hash";
import { IdempotencyService } from "../../src/idempotency/idempotency.service";

interface StoredIdempotencyRow {
  tenant_id: string;
  route: string;
  idempotency_key: string;
  request_hash: string;
  status: "IN_PROGRESS" | "COMPLETED" | "FAILED";
  response_status: number | null;
  response_body: unknown;
}

function createInMemoryIdempotencyPool() {
  const store = new Map<string, StoredIdempotencyRow>();

  const makeKey = (tenantId: string, route: string, key: string) =>
    `${tenantId}::${route}::${key}`;

  const pool = {
    query: jest.fn(async (text: string, values: unknown[] = []) => {
      const sql = text.trim();

      if (sql.startsWith("INSERT INTO idempotency_keys")) {
        const [tenantId, route, key, requestHash] = values as [string, string, string, string];
        const mapKey = makeKey(tenantId, route, key);
        if (store.has(mapKey)) {
          return { rowCount: 0, rows: [] };
        }
        store.set(mapKey, {
          tenant_id: tenantId,
          route,
          idempotency_key: key,
          request_hash: requestHash,
          status: "IN_PROGRESS",
          response_status: null,
          response_body: null,
        });
        return { rowCount: 1, rows: [{ status: "IN_PROGRESS" }] };
      }

      if (sql.includes("FROM idempotency_keys")) {
        const [tenantId, route, key] = values as [string, string, string];
        const row = store.get(makeKey(tenantId, route, key));
        return { rowCount: row ? 1 : 0, rows: row ? [row] : [] };
      }

      if (sql.includes("SET status = 'IN_PROGRESS'")) {
        const [tenantId, route, key] = values as [string, string, string];
        const row = store.get(makeKey(tenantId, route, key));
        if (row && row.status === "FAILED") {
          row.status = "IN_PROGRESS";
          return { rowCount: 1, rows: [] };
        }
        return { rowCount: 0, rows: [] };
      }

      if (sql.includes("SET status = 'COMPLETED'")) {
        const [tenantId, route, key, statusCode, bodyJson] = values as [
          string,
          string,
          string,
          number,
          string,
        ];
        const row = store.get(makeKey(tenantId, route, key));
        if (row) {
          row.status = "COMPLETED";
          row.response_status = statusCode;
          row.response_body = JSON.parse(bodyJson);
        }
        return { rowCount: row ? 1 : 0, rows: [] };
      }

      if (sql.includes("SET status = 'FAILED'")) {
        const [tenantId, route, key] = values as [string, string, string];
        const row = store.get(makeKey(tenantId, route, key));
        if (row) {
          row.status = "FAILED";
        }
        return { rowCount: row ? 1 : 0, rows: [] };
      }

      return { rowCount: 0, rows: [] };
    }),
    connect: jest.fn(),
  };

  return { pool: pool as unknown as Pool, store };
}

describe("idempotency canonical hashing", () => {
  it("produces identical SHA-256 hashes regardless of key ordering and converts bigints", () => {
    const a = { amount: 1500n, from: "A", meta: { z: 1, a: 2 } };
    const b = { meta: { a: 2, z: 1 }, from: "A", amount: "1500" };

    expect(canonicalize({ b: 1, a: 2n })).toEqual({ a: "2", b: 1 });
    expect(hashRequestPayload(a)).toBe(hashRequestPayload(b));
    expect(hashRequestPayload({ amount: 1501n })).not.toBe(hashRequestPayload(a));
  });
});

describe("IdempotencyService", () => {
  it("executes fresh requests once and replays cached COMPLETED responses", async () => {
    const { pool } = createInMemoryIdempotencyPool();
    const service = new IdempotencyService(pool);
    const handler = jest.fn(async () => ({
      statusCode: 201,
      body: { transactionId: "tx-1", amount: "500" },
    }));

    const first = await service.execute({
      tenantId: "tenant-1",
      route: "POST /api/transfers",
      idempotencyKey: "key-1",
      payload: { from: "A", to: "B", amount: 500n },
      execute: handler,
    });
    expect(first.replayed).toBe(false);
    expect(first.statusCode).toBe(201);
    expect(handler).toHaveBeenCalledTimes(1);

    const second = await service.execute({
      tenantId: "tenant-1",
      route: "POST /api/transfers",
      idempotencyKey: "key-1",
      payload: { amount: 500n, to: "B", from: "A" },
      execute: handler,
    });
    expect(second.replayed).toBe(true);
    expect(second.statusCode).toBe(201);
    expect(second.body).toEqual({ transactionId: "tx-1", amount: "500" });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("throws 422 IdempotencyPayloadMismatchError when key is reused with different payload", async () => {
    const { pool } = createInMemoryIdempotencyPool();
    const service = new IdempotencyService(pool);

    await service.execute({
      tenantId: "default",
      route: "POST /api/transfers",
      idempotencyKey: "key-mismatch",
      payload: { amount: 100n },
      execute: async () => ({ statusCode: 201, body: { ok: true } }),
    });

    await expect(
      service.execute({
        tenantId: "default",
        route: "POST /api/transfers",
        idempotencyKey: "key-mismatch",
        payload: { amount: 200n },
        execute: async () => ({ statusCode: 201, body: { ok: true } }),
      })
    ).rejects.toThrow(IdempotencyPayloadMismatchError);
  });

  it("throws 409 IdempotencyInProgressError for concurrent in-flight duplicates", async () => {
    const { pool, store } = createInMemoryIdempotencyPool();
    const service = new IdempotencyService(pool);
    const payload = { amount: 100n };

    store.set("default::POST /api/transfers::key-inflight", {
      tenant_id: "default",
      route: "POST /api/transfers",
      idempotency_key: "key-inflight",
      request_hash: hashRequestPayload(payload),
      status: "IN_PROGRESS",
      response_status: null,
      response_body: null,
    });

    await expect(
      service.execute({
        tenantId: "default",
        route: "POST /api/transfers",
        idempotencyKey: "key-inflight",
        payload,
        execute: async () => ({ statusCode: 201, body: { ok: true } }),
      })
    ).rejects.toThrow(IdempotencyInProgressError);
  });

  it("caches deterministic 4xx LedgerErrors and allows reclaiming after transient 5xx failures", async () => {
    const { pool } = createInMemoryIdempotencyPool();
    const service = new IdempotencyService(pool);

    const deterministic = await service.execute({
      tenantId: "default",
      route: "POST /api/transfers",
      idempotencyKey: "key-409",
      payload: { amount: 999n },
      execute: async () => {
        throw new InsufficientFundsError("acc-1", 100n, 999n);
      },
    });
    expect(deterministic.statusCode).toBe(409);
    expect(deterministic.replayed).toBe(false);

    const replayed409 = await service.execute({
      tenantId: "default",
      route: "POST /api/transfers",
      idempotencyKey: "key-409",
      payload: { amount: 999n },
      execute: async () => ({ statusCode: 201, body: {} }),
    });
    expect(replayed409.statusCode).toBe(409);
    expect(replayed409.replayed).toBe(true);

    let calls = 0;
    await expect(
      service.execute({
        tenantId: "default",
        route: "POST /api/transfers",
        idempotencyKey: "key-transient",
        payload: { amount: 100n },
        execute: async () => {
          calls += 1;
          throw new Error("Transient DB timeout");
        },
      })
    ).rejects.toThrow("Transient DB timeout");

    const recovered = await service.execute({
      tenantId: "default",
      route: "POST /api/transfers",
      idempotencyKey: "key-transient",
      payload: { amount: 100n },
      execute: async () => {
        calls += 1;
        return { statusCode: 201, body: { recovered: true } };
      },
    });
    expect(calls).toBe(2);
    expect(recovered.replayed).toBe(false);
    expect(recovered.body).toEqual({ recovered: true });
  });
});

describe("POST /api/transfers HTTP Idempotency-Key integration", () => {
  const idA = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  const idB = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

  it("replays 201 responses, returns 422 on payload mismatch, and sets X-Idempotency-Replayed", async () => {
    const { pool: idempPool } = createInMemoryIdempotencyPool();

    const client = {
      query: jest.fn(async (text: string) => {
        if (text.includes("FROM accounts")) {
          return {
            rows: [
              {
                id: idA,
                code: "A",
                currency: "USD",
                account_type: "USER",
                balance: "5000",
                version: 1,
                seq: "0",
                created_at: new Date("2026-11-25T10:00:00Z"),
                updated_at: new Date("2026-11-25T10:00:00Z"),
              },
              {
                id: idB,
                code: "B",
                currency: "USD",
                account_type: "USER",
                balance: "0",
                version: 1,
                seq: "0",
                created_at: new Date("2026-11-25T10:00:00Z"),
                updated_at: new Date("2026-11-25T10:00:00Z"),
              },
            ],
          };
        }
        if (text.includes("INSERT INTO journal_transactions")) {
          return { rows: [{ id: "tx-http-idemp", created_at: new Date("2026-11-25T15:00:00Z") }] };
        }
        return { rows: [] };
      }),
      release: jest.fn(),
    } as unknown as PoolClient;

    const combinedPool = {
      query: (idempPool as unknown as { query: Pool["query"] }).query,
      connect: jest.fn(async () => client),
    } as unknown as Pool;

    const app = createApp(combinedPool);
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const addr = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    try {
      const payload = {
        fromAccountId: idA,
        toAccountId: idB,
        amount: "1200",
        currency: "USD",
        description: "HTTP idempotency check",
      };

      const first = await fetch(`${baseUrl}/api/transfers`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "http-key-1",
          "X-Tenant-Id": "ewis",
        },
        body: JSON.stringify(payload),
      });
      expect(first.status).toBe(201);
      expect(first.headers.get("x-idempotency-replayed")).toBe("false");

      const replay = await fetch(`${baseUrl}/api/transfers`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "http-key-1",
          "X-Tenant-Id": "ewis",
        },
        body: JSON.stringify(payload),
      });
      expect(replay.status).toBe(201);
      expect(replay.headers.get("x-idempotency-replayed")).toBe("true");
      expect(await replay.json()).toEqual(await first.json());

      const mismatch = await fetch(`${baseUrl}/api/transfers`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "http-key-1",
          "X-Tenant-Id": "ewis",
        },
        body: JSON.stringify({ ...payload, amount: "1300" }),
      });
      expect(mismatch.status).toBe(422);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

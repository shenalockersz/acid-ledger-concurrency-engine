import { Pool } from "pg";
import {
  IdempotencyInProgressError,
  IdempotencyPayloadMismatchError,
  LedgerError,
} from "../domain/errors";
import { hashRequestPayload } from "./hash";

export type IdempotencyStatus = "IN_PROGRESS" | "COMPLETED" | "FAILED";

interface IdempotencyDbRow {
  tenant_id: string;
  route: string;
  idempotency_key: string;
  request_hash: string;
  status: IdempotencyStatus;
  response_status: number | null;
  response_body: unknown;
}

export interface IdempotentExecuteParams<T> {
  tenantId: string;
  route: string;
  idempotencyKey: string;
  payload: unknown;
  execute: () => Promise<{ statusCode: number; body: T }>;
}

export interface IdempotentExecuteResult<T> {
  statusCode: number;
  body: T | { error: { code: string; message: string } };
  replayed: boolean;
}

/**
 * Enforces Stripe-style atomic idempotency keys using PostgreSQL primary-key
 * conflict detection (`ON CONFLICT DO NOTHING`) scoped by `(tenant_id, route, key)`.
 */
export class IdempotencyService {
  constructor(private readonly pool: Pool) {}

  async execute<T>(params: IdempotentExecuteParams<T>): Promise<IdempotentExecuteResult<T>> {
    const key = params.idempotencyKey.trim();
    const requestHash = hashRequestPayload(params.payload);

    const reserveRes = await this.pool.query<{ status: IdempotencyStatus }>(
      `
      INSERT INTO idempotency_keys (tenant_id, route, idempotency_key, request_hash, status)
      VALUES ($1, $2, $3, $4, 'IN_PROGRESS')
      ON CONFLICT (tenant_id, route, idempotency_key) DO NOTHING
      RETURNING status
      `,
      [params.tenantId, params.route, key, requestHash]
    );

    if (reserveRes.rowCount === 0) {
      const existingRes = await this.pool.query<IdempotencyDbRow>(
        `
        SELECT tenant_id, route, idempotency_key, request_hash, status, response_status, response_body
        FROM idempotency_keys
        WHERE tenant_id = $1 AND route = $2 AND idempotency_key = $3
        `,
        [params.tenantId, params.route, key]
      );

      const existing = existingRes.rows[0];
      if (!existing) {
        throw new IdempotencyInProgressError(key);
      }

      if (existing.request_hash !== requestHash) {
        throw new IdempotencyPayloadMismatchError(key);
      }

      if (existing.status === "COMPLETED") {
        return {
          statusCode: existing.response_status ?? 200,
          body: existing.response_body as T,
          replayed: true,
        };
      }

      if (existing.status === "IN_PROGRESS") {
        throw new IdempotencyInProgressError(key);
      }

      // Status is FAILED (e.g., transient 5xx): atomically reclaim ownership.
      const reclaimRes = await this.pool.query(
        `
        UPDATE idempotency_keys
        SET status = 'IN_PROGRESS', updated_at = now()
        WHERE tenant_id = $1 AND route = $2 AND idempotency_key = $3 AND status = 'FAILED'
        `,
        [params.tenantId, params.route, key]
      );

      if (reclaimRes.rowCount === 0) {
        throw new IdempotencyInProgressError(key);
      }
    }

    try {
      const outcome = await params.execute();
      await this.markCompleted(params.tenantId, params.route, key, outcome.statusCode, outcome.body);
      return {
        statusCode: outcome.statusCode,
        body: outcome.body,
        replayed: false,
      };
    } catch (err) {
      if (err instanceof LedgerError && err.statusCode < 500) {
        const errorBody = {
          error: {
            code: err.code,
            message: err.message,
          },
        };
        await this.markCompleted(params.tenantId, params.route, key, err.statusCode, errorBody);
        return {
          statusCode: err.statusCode,
          body: errorBody,
          replayed: false,
        };
      }

      await this.markFailed(params.tenantId, params.route, key);
      throw err;
    }
  }

  private async markCompleted(
    tenantId: string,
    route: string,
    key: string,
    statusCode: number,
    body: unknown
  ): Promise<void> {
    await this.pool.query(
      `
      UPDATE idempotency_keys
      SET status = 'COMPLETED',
          response_status = $4,
          response_body = $5::jsonb,
          updated_at = now()
      WHERE tenant_id = $1 AND route = $2 AND idempotency_key = $3
      `,
      [tenantId, route, key, statusCode, JSON.stringify(body)]
    );
  }

  private async markFailed(tenantId: string, route: string, key: string): Promise<void> {
    await this.pool.query(
      `
      UPDATE idempotency_keys
      SET status = 'FAILED', updated_at = now()
      WHERE tenant_id = $1 AND route = $2 AND idempotency_key = $3
      `,
      [tenantId, route, key]
    );
  }
}

import { Pool, PoolClient } from "pg";

export type IsolationLevel = "READ COMMITTED" | "REPEATABLE READ" | "SERIALIZABLE";

/**
 * Create a bounded pg connection pool for the ledger service or migration runner.
 */
export function createPool(connectionString: string, max = 20): Pool {
  return new Pool({
    connectionString,
    max,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
}

/**
 * Execute work inside an explicit PostgreSQL transaction with automatic commit/rollback.
 */
export async function withTransaction<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
  isolationLevel: IsolationLevel = "READ COMMITTED"
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query(`BEGIN ISOLATION LEVEL ${isolationLevel}`);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Preserve the original error if rollback fails on a broken connection.
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function closePool(pool: Pool): Promise<void> {
  await pool.end();
}

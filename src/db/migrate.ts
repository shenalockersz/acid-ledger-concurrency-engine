import fs from "node:fs";
import path from "node:path";
import pino from "pino";
import { loadEnv } from "../config/env";
import { closePool, createPool } from "./pool";

const MIGRATION_LOCK_KEY = 88421001;

async function runMigrations(): Promise<void> {
  const env = loadEnv();
  const logger = pino({ level: env.LOG_LEVEL });
  const pool = createPool(env.DATABASE_ADMIN_URL, 4);
  const migrationsDir = path.resolve(__dirname, "../../migrations");

  const lockClient = await pool.connect();
  try {
    await lockClient.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);

    await lockClient.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    const files = fs
      .readdirSync(migrationsDir)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    const appliedResult = await lockClient.query<{ filename: string }>(
      "SELECT filename FROM schema_migrations"
    );
    const applied = new Set(appliedResult.rows.map((r) => r.filename));

    for (const file of files) {
      if (applied.has(file)) {
        logger.info({ file }, "Migration already applied, skipping");
        continue;
      }

      const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8");
      logger.info({ file }, "Applying migration");

      await lockClient.query("BEGIN");
      try {
        await lockClient.query(sql);
        await lockClient.query(
          "INSERT INTO schema_migrations (filename) VALUES ($1)",
          [file]
        );
        await lockClient.query("COMMIT");
        logger.info({ file }, "Migration applied");
      } catch (err) {
        await lockClient.query("ROLLBACK");
        throw err;
      }
    }
  } finally {
    try {
      await lockClient.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]);
    } catch {
      // Connection closing releases session-scoped advisory locks automatically.
    }
    lockClient.release();
    await closePool(pool);
  }
}

runMigrations().catch((err: unknown) => {
  console.error("Migration failed:", err);
  process.exit(1);
});

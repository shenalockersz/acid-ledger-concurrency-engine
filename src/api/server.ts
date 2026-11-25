import pino from "pino";
import { loadEnv } from "../config/env";
import { closePool, createPool } from "../db/pool";
import { createApp } from "./app";

const env = loadEnv();
const logger = pino({ level: env.LOG_LEVEL });
const pool = createPool(env.DATABASE_URL, 32);
const app = createApp(pool);

const server = app.listen(env.PORT, () => {
  logger.info({ port: env.PORT }, "ACID Ledger API listening");
});

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, "Shutting down API server");
  server.close(async () => {
    await closePool(pool);
    process.exit(0);
  });
}

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});
process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});

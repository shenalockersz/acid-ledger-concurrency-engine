import pino from "pino";
import { loadEnv } from "../config/env";
import { closePool, createPool } from "./pool";

async function seedAccounts(): Promise<void> {
  const env = loadEnv();
  const logger = pino({ level: env.LOG_LEVEL });
  const pool = createPool(env.DATABASE_ADMIN_URL, 4);

  try {
    const accounts = [
      { code: "SYSTEM_TREASURY_USD", currency: "USD", accountType: "SYSTEM", balance: 0 },
      { code: "USER_ALICE_USD", currency: "USD", accountType: "USER", balance: 10_000 },
      { code: "USER_BOB_USD", currency: "USD", accountType: "USER", balance: 5_000 },
    ];

    for (const acc of accounts) {
      await pool.query(
        `
        INSERT INTO accounts (code, currency, account_type, balance)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (code) DO NOTHING
        `,
        [acc.code, acc.currency, acc.accountType, acc.balance]
      );
    }

    logger.info({ count: accounts.length }, "Seeded baseline ledger accounts");
  } finally {
    await closePool(pool);
  }
}

seedAccounts().catch((err: unknown) => {
  console.error("Seed failed:", err);
  process.exit(1);
});

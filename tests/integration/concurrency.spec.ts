import { Pool } from "pg";
import { loadEnv } from "../../src/config/env";
import { closePool, createPool } from "../../src/db/pool";
import {
  IdempotencyInProgressError,
  IdempotencyPayloadMismatchError,
  InsufficientFundsError,
} from "../../src/domain/errors";
import { IdempotencyService } from "../../src/idempotency/idempotency.service";
import { AccountRepository } from "../../src/ledger/account.repository";
import { OptimisticTransferStrategy } from "../../src/ledger/optimistic-transfer.strategy";
import { PessimisticTransferStrategy } from "../../src/ledger/pessimistic-transfer.strategy";

jest.setTimeout(30_000);

function isPgDeadlock(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === "40P01"
  );
}

async function ensureSystemTreasury(repo: AccountRepository): Promise<string> {
  const existing = await repo.getByCode("SYSTEM_TREASURY_USD");
  if (existing) {
    return existing.id;
  }
  try {
    const created = await repo.createAccount({
      code: "SYSTEM_TREASURY_USD",
      currency: "USD",
      accountType: "SYSTEM",
      initialBalance: 0n,
    });
    return created.id;
  } catch {
    const retry = await repo.getByCode("SYSTEM_TREASURY_USD");
    if (!retry) {
      throw new Error("Could not initialize SYSTEM_TREASURY_USD");
    }
    return retry.id;
  }
}

describe("PostgreSQL ACID & Concurrency Barrier Integration Suite", () => {
  let appPool: Pool;
  let adminPool: Pool;
  let repo: AccountRepository;
  let pessimistic: PessimisticTransferStrategy;
  let treasuryId: string;

  beforeAll(async () => {
    const env = loadEnv();
    appPool = createPool(env.DATABASE_URL, 32);
    adminPool = createPool(env.DATABASE_ADMIN_URL, 8);
    repo = new AccountRepository(appPool);
    pessimistic = new PessimisticTransferStrategy(appPool);
    treasuryId = await ensureSystemTreasury(repo);
  });

  afterAll(async () => {
    await closePool(appPool);
    await closePool(adminPool);
  });

  it("rejects unbalanced journal transactions via deferred constraint trigger", async () => {
    const tag = `INT_UNBAL_${Date.now()}`;
    const acc = await repo.createAccount({
      code: tag,
      currency: "USD",
      accountType: "USER",
      initialBalance: 0n,
    });

    const client = await adminPool.connect();
    try {
      await client.query("BEGIN");
      const txRes = await client.query<{ id: string }>(
        `INSERT INTO journal_transactions (currency, description) VALUES ('USD', 'Unbalanced test') RETURNING id`
      );
      const txId = txRes.rows[0]?.id;
      await client.query(
        `INSERT INTO ledger_entries (transaction_id, account_id, direction, amount, account_seq, balance_after)
         VALUES ($1, $2, 'CREDIT', 500, 1, 500)`,
        [txId, acc.id]
      );

      await expect(client.query("COMMIT")).rejects.toThrow(/at least 2 ledger entries|Unbalanced/i);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });

  it("enforces append-only immutability on ledger_entries against UPDATE and DELETE", async () => {
    const tag = `INT_IMMUT_${Date.now()}`;
    const wallet = await repo.createAccount({
      code: tag,
      currency: "USD",
      accountType: "USER",
      initialBalance: 0n,
    });

    const tx = await pessimistic.transfer({
      fromAccountId: treasuryId,
      toAccountId: wallet.id,
      amount: 2500n,
      currency: "USD",
      description: "Immutability seed transfer",
    });

    await expect(
      adminPool.query("UPDATE ledger_entries SET amount = 9999 WHERE transaction_id = $1", [
        tx.transactionId,
      ])
    ).rejects.toThrow(/append-only/i);

    await expect(
      adminPool.query("DELETE FROM ledger_entries WHERE transaction_id = $1", [tx.transactionId])
    ).rejects.toThrow(/append-only/i);
  });

  it("prevents overdraft across 50 simultaneous $10 withdrawals on a $100 wallet", async () => {
    const tag = `${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    const wallet = await repo.createAccount({
      code: `INT_RACE_WALLET_${tag}`,
      currency: "USD",
      accountType: "USER",
      initialBalance: 0n,
    });
    const merchant = await repo.createAccount({
      code: `INT_RACE_MERCHANT_${tag}`,
      currency: "USD",
      accountType: "USER",
      initialBalance: 0n,
    });

    await pessimistic.transfer({
      fromAccountId: treasuryId,
      toAccountId: wallet.id,
      amount: 10_000n,
      currency: "USD",
      description: `Fund race wallet ${tag}`,
    });

    let succeeded = 0;
    let insufficient = 0;
    const otherErrors: unknown[] = [];

    await Promise.all(
      Array.from({ length: 50 }, async (_, idx) => {
        try {
          await pessimistic.transfer({
            fromAccountId: wallet.id,
            toAccountId: merchant.id,
            amount: 1_000n,
            currency: "USD",
            description: `Concurrent withdrawal #${idx + 1}`,
          });
          succeeded += 1;
        } catch (err) {
          if (err instanceof InsufficientFundsError) {
            insufficient += 1;
          } else {
            otherErrors.push(err);
          }
        }
      })
    );

    expect(otherErrors).toEqual([]);
    expect(succeeded).toBe(10);
    expect(insufficient).toBe(40);

    const afterWallet = await repo.getById(wallet.id);
    const afterMerchant = await repo.getById(merchant.id);
    expect(afterWallet.balance).toBe(0n);
    expect(afterMerchant.balance).toBe(10_000n);

    const entries = await repo.getEntriesForAccount(wallet.id);
    expect(entries).toHaveLength(11);
    expect(entries.map((e) => e.accountSeq)).toEqual([
      1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n, 9n, 10n, 11n,
    ]);
  });

  it("completes 40 simultaneous bidirectional transfers (20 A->B and 20 B->A) with zero deadlocks", async () => {
    const tag = `${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    const accountA = await repo.createAccount({
      code: `INT_DL_A_${tag}`,
      currency: "USD",
      accountType: "USER",
      initialBalance: 0n,
    });
    const accountB = await repo.createAccount({
      code: `INT_DL_B_${tag}`,
      currency: "USD",
      accountType: "USER",
      initialBalance: 0n,
    });

    await pessimistic.transfer({
      fromAccountId: treasuryId,
      toAccountId: accountA.id,
      amount: 5_000n,
      currency: "USD",
      description: `Fund DL A ${tag}`,
    });
    await pessimistic.transfer({
      fromAccountId: treasuryId,
      toAccountId: accountB.id,
      amount: 5_000n,
      currency: "USD",
      description: `Fund DL B ${tag}`,
    });

    const transfers = [
      ...Array.from({ length: 20 }, (_, i) => ({
        from: accountA.id,
        to: accountB.id,
        label: `A->B #${i + 1}`,
      })),
      ...Array.from({ length: 20 }, (_, i) => ({
        from: accountB.id,
        to: accountA.id,
        label: `B->A #${i + 1}`,
      })),
    ];

    let succeeded = 0;
    let deadlocks = 0;
    const otherErrors: unknown[] = [];

    await Promise.all(
      transfers.map(async (t) => {
        try {
          await pessimistic.transfer({
            fromAccountId: t.from,
            toAccountId: t.to,
            amount: 100n,
            currency: "USD",
            description: t.label,
          });
          succeeded += 1;
        } catch (err) {
          if (isPgDeadlock(err)) {
            deadlocks += 1;
          } else {
            otherErrors.push(err);
          }
        }
      })
    );

    expect(otherErrors).toEqual([]);
    expect(deadlocks).toBe(0);
    expect(succeeded).toBe(40);

    const afterA = await repo.getById(accountA.id);
    const afterB = await repo.getById(accountB.id);
    expect(afterA.balance + afterB.balance).toBe(10_000n);
  });

  it("maintains exact balance conservation under concurrent OCC contention", async () => {
    const tag = `${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    const source = await repo.createAccount({
      code: `INT_OCC_SRC_${tag}`,
      currency: "USD",
      accountType: "USER",
      initialBalance: 0n,
    });
    const sink = await repo.createAccount({
      code: `INT_OCC_SINK_${tag}`,
      currency: "USD",
      accountType: "USER",
      initialBalance: 0n,
    });

    await pessimistic.transfer({
      fromAccountId: treasuryId,
      toAccountId: source.id,
      amount: 10_000n,
      currency: "USD",
      description: `Fund OCC source ${tag}`,
    });

    const occ = new OptimisticTransferStrategy(appPool, {
      maxRetries: 15,
      baseBackoffMs: 5,
      maxBackoffMs: 80,
    });

    let succeeded = 0;
    let totalAttempts = 0;

    await Promise.all(
      Array.from({ length: 15 }, async (_, idx) => {
        try {
          const res = await occ.transfer({
            fromAccountId: source.id,
            toAccountId: sink.id,
            amount: 100n,
            currency: "USD",
            description: `OCC concurrent #${idx + 1}`,
          });
          succeeded += 1;
          totalAttempts += res.attempts;
        } catch {
          // Bounded retries may still conflict under 15-way single-row contention.
        }
      })
    );

    expect(succeeded).toBeGreaterThan(0);
    expect(totalAttempts).toBeGreaterThanOrEqual(succeeded);

    const afterSource = await repo.getById(source.id);
    const afterSink = await repo.getById(sink.id);
    expect(afterSource.balance).toBe(10_000n - BigInt(succeeded) * 100n);
    expect(afterSink.balance).toBe(BigInt(succeeded) * 100n);
  });

  it("executes exactly once across 10 simultaneous Idempotency-Key requests and blocks mismatches", async () => {
    const tag = `${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    const source = await repo.createAccount({
      code: `INT_IDEMP_SRC_${tag}`,
      currency: "USD",
      accountType: "USER",
      initialBalance: 0n,
    });
    const sink = await repo.createAccount({
      code: `INT_IDEMP_SINK_${tag}`,
      currency: "USD",
      accountType: "USER",
      initialBalance: 0n,
    });

    await pessimistic.transfer({
      fromAccountId: treasuryId,
      toAccountId: source.id,
      amount: 5_000n,
      currency: "USD",
      description: `Fund idemp source ${tag}`,
    });

    const idemp = new IdempotencyService(appPool);
    const payload = {
      fromAccountId: source.id,
      toAccountId: sink.id,
      amount: "1500",
      currency: "USD",
      description: "Idempotency race",
    };
    const key = `race-key-${tag}`;

    let executedCount = 0;
    let initialCreated = 0;
    let replayedCount = 0;
    let inProgressConflicts = 0;

    await Promise.all(
      Array.from({ length: 10 }, async () => {
        try {
          const outcome = await idemp.execute({
            tenantId: "integration",
            route: "POST /api/transfers",
            idempotencyKey: key,
            payload,
            execute: async () => {
              executedCount += 1;
              const tx = await pessimistic.transfer({
                fromAccountId: source.id,
                toAccountId: sink.id,
                amount: 1_500n,
                currency: "USD",
                description: "Idempotency race transfer",
              });
              return { statusCode: 201, body: { transactionId: tx.transactionId } };
            },
          });
          if (outcome.replayed) {
            replayedCount += 1;
          } else {
            initialCreated += 1;
          }
        } catch (err) {
          if (err instanceof IdempotencyInProgressError) {
            inProgressConflicts += 1;
          } else {
            throw err;
          }
        }
      })
    );

    expect(executedCount).toBe(1);
    expect(initialCreated).toBe(1);
    expect(replayedCount + inProgressConflicts).toBe(9);

    const replay = await idemp.execute({
      tenantId: "integration",
      route: "POST /api/transfers",
      idempotencyKey: key,
      payload,
      execute: async () => ({ statusCode: 201, body: { transactionId: "should-not-run" } }),
    });
    expect(replay.replayed).toBe(true);
    expect(replay.statusCode).toBe(201);

    await expect(
      idemp.execute({
        tenantId: "integration",
        route: "POST /api/transfers",
        idempotencyKey: key,
        payload: { ...payload, amount: "1600" },
        execute: async () => ({ statusCode: 201, body: {} }),
      })
    ).rejects.toThrow(IdempotencyPayloadMismatchError);

    const afterSource = await repo.getById(source.id);
    expect(afterSource.balance).toBe(3_500n);
  });
});

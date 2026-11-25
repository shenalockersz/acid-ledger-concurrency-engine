import express, { NextFunction, Request, RequestHandler, Response } from "express";
import { Pool } from "pg";
import { z, ZodError } from "zod";
import { InsufficientFundsError, LedgerError } from "../domain/errors";
import { AccountRecord } from "../domain/types";
import { AccountRepository } from "../ledger/account.repository";
import { PessimisticTransferStrategy } from "../ledger/pessimistic-transfer.strategy";
import { formatMinorUnits, summarizeLatencies } from "./metrics";

const transferBodySchema = z.object({
  fromAccountId: z.string().min(1),
  toAccountId: z.string().min(1),
  amount: z.coerce.bigint().positive(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  description: z.string().trim().min(1),
  referenceId: z.string().trim().min(1).optional(),
});

const raceWithdrawalsBodySchema = z.object({
  concurrency: z.number().int().min(2).max(200).default(50),
  initialBalance: z.number().int().min(100).max(10_000_000).default(10_000),
  withdrawalAmount: z.number().int().min(1).max(1_000_000).default(1_000),
});

const deadlockStressBodySchema = z.object({
  pairs: z.number().int().min(1).max(100).default(20),
  amount: z.number().int().min(1).max(100_000).default(100),
});

function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>
): RequestHandler {
  return (req, res, next) => {
    void fn(req, res, next).catch(next);
  };
}

function isPgDeadlock(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === "40P01"
  );
}

async function getOrCreateSystemAccount(
  repo: AccountRepository,
  currency: string
): Promise<AccountRecord> {
  const code = `SYSTEM_TREASURY_${currency}`;
  const existing = await repo.getByCode(code);
  if (existing) {
    return existing;
  }
  try {
    return await repo.createAccount({
      code,
      currency,
      accountType: "SYSTEM",
      initialBalance: 0n,
    });
  } catch {
    const retry = await repo.getByCode(code);
    if (!retry) {
      throw new Error(`Failed to resolve system account ${code}`);
    }
    return retry;
  }
}

function serializeAccount(acc: AccountRecord) {
  return {
    id: acc.id,
    code: acc.code,
    currency: acc.currency,
    accountType: acc.accountType,
    balance: acc.balance.toString(),
    balanceFormatted: formatMinorUnits(acc.balance, acc.currency),
    version: acc.version,
    seq: acc.seq.toString(),
    createdAt: acc.createdAt.toISOString(),
    updatedAt: acc.updatedAt.toISOString(),
  };
}

export function createApp(pool: Pool): express.Express {
  const app = express();
  const repo = new AccountRepository(pool);
  const strategy = new PessimisticTransferStrategy(pool);

  app.use(express.json());

  app.get(
    "/api/health",
    asyncHandler(async (_req, res) => {
      try {
        await pool.query("SELECT 1");
        res.json({
          status: "ok",
          db: "connected",
          strategy: strategy.name,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Database unreachable";
        res.status(503).json({
          status: "degraded",
          db: "unavailable",
          strategy: strategy.name,
          error: message,
        });
      }
    })
  );

  app.get(
    "/api/accounts",
    asyncHandler(async (_req, res) => {
      const accounts = await repo.listAccounts();
      const globalBalanceSum = accounts.reduce((sum, acc) => sum + acc.balance, 0n);

      res.json({
        accounts: accounts.map(serializeAccount),
        invariants: {
          accountCount: accounts.length,
          globalBalanceSum: globalBalanceSum.toString(),
          globalBalanceFormatted: formatMinorUnits(globalBalanceSum, "USD"),
          balanced: globalBalanceSum === 0n,
        },
      });
    })
  );

  app.get(
    "/api/accounts/:id/entries",
    asyncHandler(async (req, res) => {
      const accountId = String(req.params.id ?? "");
      const account = await repo.getById(accountId);
      const entries = await repo.getEntriesForAccount(account.id);

      res.json({
        account: serializeAccount(account),
        entries: entries.map((e) => ({
          id: e.id,
          transactionId: e.transactionId,
          accountId: e.accountId,
          direction: e.direction,
          amount: e.amount.toString(),
          amountFormatted: formatMinorUnits(e.amount, account.currency),
          accountSeq: e.accountSeq.toString(),
          balanceAfter: e.balanceAfter.toString(),
          balanceAfterFormatted: formatMinorUnits(e.balanceAfter, account.currency),
          createdAt: e.createdAt.toISOString(),
        })),
      });
    })
  );

  app.post(
    "/api/transfers",
    asyncHandler(async (req, res) => {
      const body = transferBodySchema.parse(req.body);
      const result = await strategy.transfer({
        fromAccountId: body.fromAccountId,
        toAccountId: body.toAccountId,
        amount: body.amount,
        currency: body.currency,
        description: body.description,
        referenceId: body.referenceId,
      });

      res.status(201).json({
        transactionId: result.transactionId,
        fromAccountId: result.fromAccountId,
        toAccountId: result.toAccountId,
        amount: result.amount.toString(),
        currency: result.currency,
        fromBalanceAfter: result.fromBalanceAfter.toString(),
        toBalanceAfter: result.toBalanceAfter.toString(),
        strategy: result.strategy,
        attempts: result.attempts,
        createdAt: result.createdAt.toISOString(),
      });
    })
  );

  app.post(
    "/api/lab/race-withdrawals",
    asyncHandler(async (req, res) => {
      const body = raceWithdrawalsBodySchema.parse(req.body ?? {});
      const tag = `${Date.now()}_${Math.floor(Math.random() * 10_000)}`;
      const treasury = await getOrCreateSystemAccount(repo, "USD");
      const wallet = await repo.createAccount({
        code: `LAB_WALLET_${tag}`,
        currency: "USD",
        accountType: "USER",
        initialBalance: 0n,
      });
      const sink = await repo.createAccount({
        code: `LAB_MERCHANT_${tag}`,
        currency: "USD",
        accountType: "USER",
        initialBalance: 0n,
      });

      await strategy.transfer({
        fromAccountId: treasury.id,
        toAccountId: wallet.id,
        amount: BigInt(body.initialBalance),
        currency: "USD",
        description: `Lab wallet funding (${tag})`,
      });

      let succeeded = 0;
      let rejectedInsufficientFunds = 0;
      let failedOther = 0;
      const latenciesMs: number[] = [];

      const t0 = performance.now();
      await Promise.all(
        Array.from({ length: body.concurrency }, async (_, idx) => {
          const reqStart = performance.now();
          try {
            await strategy.transfer({
              fromAccountId: wallet.id,
              toAccountId: sink.id,
              amount: BigInt(body.withdrawalAmount),
              currency: "USD",
              description: `Race withdrawal #${idx + 1} (${tag})`,
            });
            succeeded += 1;
          } catch (err) {
            if (err instanceof InsufficientFundsError) {
              rejectedInsufficientFunds += 1;
            } else {
              failedOther += 1;
            }
          } finally {
            latenciesMs.push(Number((performance.now() - reqStart).toFixed(2)));
          }
        })
      );
      const totalDurationMs = performance.now() - t0;

      const afterWallet = await repo.getById(wallet.id);
      const expectedSucceeded = Math.min(
        body.concurrency,
        Math.floor(body.initialBalance / body.withdrawalAmount)
      );
      const expectedBalance = BigInt(
        body.initialBalance - expectedSucceeded * body.withdrawalAmount
      );
      const invariantPassed =
        succeeded === expectedSucceeded &&
        afterWallet.balance === expectedBalance &&
        failedOther === 0;

      res.json({
        strategy: strategy.name,
        concurrency: body.concurrency,
        initialBalance: String(body.initialBalance),
        initialBalanceFormatted: formatMinorUnits(BigInt(body.initialBalance), "USD"),
        withdrawalAmount: String(body.withdrawalAmount),
        withdrawalAmountFormatted: formatMinorUnits(BigInt(body.withdrawalAmount), "USD"),
        succeeded,
        rejectedInsufficientFunds,
        failedOther,
        expectedSucceeded,
        finalBalance: afterWallet.balance.toString(),
        finalBalanceFormatted: formatMinorUnits(afterWallet.balance, "USD"),
        invariantPassed,
        walletAccountId: wallet.id,
        sinkAccountId: sink.id,
        metrics: summarizeLatencies(latenciesMs, totalDurationMs, succeeded),
        sampleLatenciesMs: latenciesMs,
      });
    })
  );

  app.post(
    "/api/lab/deadlock-stress",
    asyncHandler(async (req, res) => {
      const body = deadlockStressBodySchema.parse(req.body ?? {});
      const tag = `${Date.now()}_${Math.floor(Math.random() * 10_000)}`;
      const treasury = await getOrCreateSystemAccount(repo, "USD");
      const accountA = await repo.createAccount({
        code: `LAB_DL_A_${tag}`,
        currency: "USD",
        accountType: "USER",
        initialBalance: 0n,
      });
      const accountB = await repo.createAccount({
        code: `LAB_DL_B_${tag}`,
        currency: "USD",
        accountType: "USER",
        initialBalance: 0n,
      });

      const startingEach = BigInt(body.pairs * body.amount * 2);
      await strategy.transfer({
        fromAccountId: treasury.id,
        toAccountId: accountA.id,
        amount: startingEach,
        currency: "USD",
        description: `Deadlock lab funding A (${tag})`,
      });
      await strategy.transfer({
        fromAccountId: treasury.id,
        toAccountId: accountB.id,
        amount: startingEach,
        currency: "USD",
        description: `Deadlock lab funding B (${tag})`,
      });

      let succeeded = 0;
      let deadlocks = 0;
      let failedOther = 0;
      const latenciesMs: number[] = [];

      const jobs = [
        ...Array.from({ length: body.pairs }, (_, idx) => ({
          from: accountA.id,
          to: accountB.id,
          label: `A->B #${idx + 1}`,
        })),
        ...Array.from({ length: body.pairs }, (_, idx) => ({
          from: accountB.id,
          to: accountA.id,
          label: `B->A #${idx + 1}`,
        })),
      ];

      const t0 = performance.now();
      await Promise.all(
        jobs.map(async (job) => {
          const reqStart = performance.now();
          try {
            await strategy.transfer({
              fromAccountId: job.from,
              toAccountId: job.to,
              amount: BigInt(body.amount),
              currency: "USD",
              description: `Deadlock stress ${job.label} (${tag})`,
            });
            succeeded += 1;
          } catch (err) {
            if (isPgDeadlock(err)) {
              deadlocks += 1;
            } else {
              failedOther += 1;
            }
          } finally {
            latenciesMs.push(Number((performance.now() - reqStart).toFixed(2)));
          }
        })
      );
      const totalDurationMs = performance.now() - t0;

      const afterA = await repo.getById(accountA.id);
      const afterB = await repo.getById(accountB.id);
      const expectedTotal = startingEach * 2n;
      const actualTotal = afterA.balance + afterB.balance;
      const invariantPassed =
        actualTotal === expectedTotal && deadlocks === 0 && failedOther === 0;

      res.json({
        strategy: strategy.name,
        totalTransfers: jobs.length,
        pairs: body.pairs,
        amount: String(body.amount),
        succeeded,
        deadlocks,
        failedOther,
        balanceA: afterA.balance.toString(),
        balanceB: afterB.balance.toString(),
        conservedTotalFormatted: formatMinorUnits(actualTotal, "USD"),
        invariantPassed,
        accountAId: accountA.id,
        accountBId: accountB.id,
        metrics: summarizeLatencies(latenciesMs, totalDurationMs, succeeded),
        sampleLatenciesMs: latenciesMs,
      });
    })
  );

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ZodError) {
      res.status(400).json({
        error: {
          code: "VALIDATION_ERROR",
          message: err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
        },
      });
      return;
    }
    if (err instanceof LedgerError) {
      res.status(err.statusCode).json({
        error: {
          code: err.code,
          message: err.message,
        },
      });
      return;
    }
    const message = err instanceof Error ? err.message : "Internal server error";
    res.status(500).json({
      error: {
        code: "INTERNAL_ERROR",
        message,
      },
    });
  });

  return app;
}

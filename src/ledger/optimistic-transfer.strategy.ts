import { Pool, PoolClient } from "pg";
import { withTransaction } from "../db/pool";
import { OptimisticLockConflictError } from "../domain/errors";
import { AccountRecord, TransferInput, TransferResult, TransferStrategy } from "../domain/types";
import { AccountDbRow, mapAccountRow } from "./account.repository";
import { insertJournalAndEntries, validateLoadedAccounts } from "./transfer-helpers";
import { sortAccountIdsForLocking, validateTransferInput } from "./validation";

export interface OptimisticTransferOptions {
  maxRetries?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Executes double-entry transfers using Optimistic Concurrency Control (OCC):
 * reads account versions without locking, updates with `WHERE id = $1 AND version = $4`,
 * and retries stale-version conflicts with bounded exponential backoff + jitter.
 */
export class OptimisticTransferStrategy implements TransferStrategy {
  readonly name = "optimistic" as const;

  private readonly maxRetries: number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;

  constructor(private readonly pool: Pool, options: OptimisticTransferOptions = {}) {
    this.maxRetries = options.maxRetries ?? 8;
    this.baseBackoffMs = options.baseBackoffMs ?? 5;
    this.maxBackoffMs = options.maxBackoffMs ?? 100;
    this.sleep = options.sleep ?? defaultSleep;
    this.random = options.random ?? Math.random;
  }

  async transfer(input: TransferInput): Promise<TransferResult> {
    validateTransferInput(input);

    for (let attempt = 1; attempt <= this.maxRetries + 1; attempt += 1) {
      try {
        return await withTransaction(
          this.pool,
          async (client) => this.executeOptimisticAttempt(client, input, attempt),
          "READ COMMITTED"
        );
      } catch (err) {
        if (err instanceof OptimisticLockConflictError && attempt <= this.maxRetries) {
          const cap = Math.min(this.maxBackoffMs, this.baseBackoffMs * 2 ** (attempt - 1));
          const jitterMs = Math.max(1, Math.round(cap * (0.5 + this.random() * 0.5)));
          await this.sleep(jitterMs);
          continue;
        }
        throw err;
      }
    }

    throw new OptimisticLockConflictError(input.fromAccountId);
  }

  private async executeOptimisticAttempt(
    client: PoolClient,
    input: TransferInput,
    attempt: number
  ): Promise<TransferResult> {
    const [firstId, secondId] = sortAccountIdsForLocking(
      input.fromAccountId,
      input.toAccountId
    );

    const readResult = await client.query<AccountDbRow>(
      `
      SELECT id, code, currency, account_type, balance, version, seq, created_at, updated_at
      FROM accounts
      WHERE id IN ($1, $2)
      `,
      [firstId, secondId]
    );

    const byId = new Map<string, AccountRecord>();
    for (const row of readResult.rows) {
      const account = mapAccountRow(row);
      byId.set(account.id, account);
    }

    const { fromAccount, toAccount } = validateLoadedAccounts(byId, input);

    const fromBalanceAfter = fromAccount.balance - input.amount;
    const toBalanceAfter = toAccount.balance + input.amount;
    const fromNextSeq = fromAccount.seq + 1n;
    const toNextSeq = toAccount.seq + 1n;

    // Apply CAS updates in deterministic ascending ID order so implicit row locks
    // held until COMMIT never form circular waits across simultaneous transfers.
    const updates =
      fromAccount.id < toAccount.id
        ? [
            { account: fromAccount, balanceAfter: fromBalanceAfter, nextSeq: fromNextSeq },
            { account: toAccount, balanceAfter: toBalanceAfter, nextSeq: toNextSeq },
          ]
        : [
            { account: toAccount, balanceAfter: toBalanceAfter, nextSeq: toNextSeq },
            { account: fromAccount, balanceAfter: fromBalanceAfter, nextSeq: fromNextSeq },
          ];

    for (const u of updates) {
      const res = await client.query(
        `
        UPDATE accounts
        SET balance = $2, seq = $3, version = version + 1, updated_at = now()
        WHERE id = $1 AND version = $4
        `,
        [u.account.id, u.balanceAfter.toString(), u.nextSeq.toString(), u.account.version]
      );

      if (res.rowCount === 0) {
        throw new OptimisticLockConflictError(u.account.id);
      }
    }

    return insertJournalAndEntries(client, {
      input,
      fromAccount,
      toAccount,
      fromBalanceAfter,
      toBalanceAfter,
      fromNextSeq,
      toNextSeq,
      strategy: this.name,
      attempts: attempt,
    });
  }
}

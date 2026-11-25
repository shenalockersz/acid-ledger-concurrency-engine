import { Pool, PoolClient } from "pg";
import { withTransaction } from "../db/pool";
import { AccountRecord, TransferInput, TransferResult, TransferStrategy } from "../domain/types";
import { AccountDbRow, mapAccountRow } from "./account.repository";
import { insertJournalAndEntries, validateLoadedAccounts } from "./transfer-helpers";
import { sortAccountIdsForLocking, validateTransferInput } from "./validation";

/**
 * Executes double-entry transfers using PostgreSQL row-level pessimistic locking
 * (`SELECT ... FOR UPDATE`) with deterministic ascending account ID lock ordering
 * to prevent bidirectional deadlocks under concurrent contention.
 */
export class PessimisticTransferStrategy implements TransferStrategy {
  readonly name = "pessimistic" as const;

  constructor(private readonly pool: Pool) {}

  async transfer(input: TransferInput): Promise<TransferResult> {
    validateTransferInput(input);

    return withTransaction(
      this.pool,
      async (client) => this.executeLockedTransfer(client, input),
      "READ COMMITTED"
    );
  }

  private async executeLockedTransfer(
    client: PoolClient,
    input: TransferInput
  ): Promise<TransferResult> {
    const [firstLockId, secondLockId] = sortAccountIdsForLocking(
      input.fromAccountId,
      input.toAccountId
    );

    const lockedResult = await client.query<AccountDbRow>(
      `
      SELECT id, code, currency, account_type, balance, version, seq, created_at, updated_at
      FROM accounts
      WHERE id IN ($1, $2)
      ORDER BY id ASC
      FOR UPDATE
      `,
      [firstLockId, secondLockId]
    );

    const byId = new Map<string, AccountRecord>();
    for (const row of lockedResult.rows) {
      const account = mapAccountRow(row);
      byId.set(account.id, account);
    }

    const { fromAccount, toAccount } = validateLoadedAccounts(byId, input);

    const fromBalanceAfter = fromAccount.balance - input.amount;
    const toBalanceAfter = toAccount.balance + input.amount;
    const fromNextSeq = fromAccount.seq + 1n;
    const toNextSeq = toAccount.seq + 1n;

    await client.query(
      `
      UPDATE accounts
      SET balance = $2, seq = $3, version = version + 1, updated_at = now()
      WHERE id = $1
      `,
      [fromAccount.id, fromBalanceAfter.toString(), fromNextSeq.toString()]
    );

    await client.query(
      `
      UPDATE accounts
      SET balance = $2, seq = $3, version = version + 1, updated_at = now()
      WHERE id = $1
      `,
      [toAccount.id, toBalanceAfter.toString(), toNextSeq.toString()]
    );

    return insertJournalAndEntries(client, {
      input,
      fromAccount,
      toAccount,
      fromBalanceAfter,
      toBalanceAfter,
      fromNextSeq,
      toNextSeq,
      strategy: this.name,
      attempts: 1,
    });
  }
}

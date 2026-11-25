import { PoolClient } from "pg";
import {
  AccountNotFoundError,
  CurrencyMismatchError,
  DuplicateReferenceError,
  InsufficientFundsError,
} from "../domain/errors";
import { AccountRecord, TransferInput, TransferResult } from "../domain/types";

export function isPgUniqueViolation(err: unknown): err is { code: string } {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === "23505"
  );
}

export function validateLoadedAccounts(
  byId: Map<string, AccountRecord>,
  input: TransferInput
): { fromAccount: AccountRecord; toAccount: AccountRecord } {
  const fromAccount = byId.get(input.fromAccountId);
  if (!fromAccount) {
    throw new AccountNotFoundError(input.fromAccountId);
  }

  const toAccount = byId.get(input.toAccountId);
  if (!toAccount) {
    throw new AccountNotFoundError(input.toAccountId);
  }

  if (fromAccount.currency !== input.currency || toAccount.currency !== input.currency) {
    throw new CurrencyMismatchError(
      `Transfer currency ${input.currency} does not match account currencies (${fromAccount.currency}, ${toAccount.currency})`
    );
  }

  if (fromAccount.accountType !== "SYSTEM" && fromAccount.balance < input.amount) {
    throw new InsufficientFundsError(fromAccount.id, fromAccount.balance, input.amount);
  }

  return { fromAccount, toAccount };
}

export async function insertJournalAndEntries(
  client: PoolClient,
  params: {
    input: TransferInput;
    fromAccount: AccountRecord;
    toAccount: AccountRecord;
    fromBalanceAfter: bigint;
    toBalanceAfter: bigint;
    fromNextSeq: bigint;
    toNextSeq: bigint;
    strategy: "pessimistic" | "optimistic";
    attempts: number;
  }
): Promise<TransferResult> {
  const {
    input,
    fromAccount,
    toAccount,
    fromBalanceAfter,
    toBalanceAfter,
    fromNextSeq,
    toNextSeq,
    strategy,
    attempts,
  } = params;

  let txRow: { id: string; created_at: Date } | undefined;
  try {
    const txRes = await client.query<{ id: string; created_at: Date }>(
      `
      INSERT INTO journal_transactions (reference_id, currency, description)
      VALUES ($1, $2, $3)
      RETURNING id, created_at
      `,
      [input.referenceId ?? null, input.currency, input.description.trim()]
    );
    txRow = txRes.rows[0];
  } catch (err) {
    if (input.referenceId && isPgUniqueViolation(err)) {
      throw new DuplicateReferenceError(input.referenceId);
    }
    throw err;
  }

  if (!txRow) {
    throw new Error("Failed to insert journal transaction");
  }

  await client.query(
    `
    INSERT INTO ledger_entries (transaction_id, account_id, direction, amount, account_seq, balance_after)
    VALUES
      ($1, $2, 'DEBIT', $3, $4, $5),
      ($1, $6, 'CREDIT', $3, $7, $8)
    `,
    [
      txRow.id,
      fromAccount.id,
      input.amount.toString(),
      fromNextSeq.toString(),
      fromBalanceAfter.toString(),
      toAccount.id,
      toNextSeq.toString(),
      toBalanceAfter.toString(),
    ]
  );

  return {
    transactionId: txRow.id,
    fromAccountId: fromAccount.id,
    toAccountId: toAccount.id,
    amount: input.amount,
    currency: input.currency,
    fromBalanceAfter,
    toBalanceAfter,
    strategy,
    attempts,
    createdAt: txRow.created_at,
  };
}

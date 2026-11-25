import { Pool } from "pg";
import { AccountNotFoundError } from "../domain/errors";
import {
  AccountRecord,
  AccountType,
  CreateAccountInput,
  EntryDirection,
  LedgerEntryRecord,
} from "../domain/types";

export interface AccountDbRow {
  id: string;
  code: string;
  currency: string;
  account_type: AccountType;
  balance: string;
  version: number;
  seq: string;
  created_at: Date;
  updated_at: Date;
}

interface LedgerEntryDbRow {
  id: string;
  transaction_id: string;
  account_id: string;
  direction: EntryDirection;
  amount: string;
  account_seq: string;
  balance_after: string;
  created_at: Date;
}

export function mapAccountRow(row: AccountDbRow): AccountRecord {
  return {
    id: row.id,
    code: row.code,
    currency: row.currency,
    accountType: row.account_type,
    balance: BigInt(row.balance),
    version: row.version,
    seq: BigInt(row.seq),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapEntryRow(row: LedgerEntryDbRow): LedgerEntryRecord {
  return {
    id: row.id,
    transactionId: row.transaction_id,
    accountId: row.account_id,
    direction: row.direction,
    amount: BigInt(row.amount),
    accountSeq: BigInt(row.account_seq),
    balanceAfter: BigInt(row.balance_after),
    createdAt: row.created_at,
  };
}

export class AccountRepository {
  constructor(private readonly pool: Pool) {}

  async createAccount(input: CreateAccountInput): Promise<AccountRecord> {
    const balance = (input.initialBalance ?? 0n).toString();
    const res = await this.pool.query<AccountDbRow>(
      `
      INSERT INTO accounts (code, currency, account_type, balance)
      VALUES ($1, $2, $3, $4)
      RETURNING id, code, currency, account_type, balance, version, seq, created_at, updated_at
      `,
      [input.code, input.currency, input.accountType, balance]
    );
    const row = res.rows[0];
    if (!row) {
      throw new Error("Failed to insert account");
    }
    return mapAccountRow(row);
  }

  async getById(accountId: string): Promise<AccountRecord> {
    const res = await this.pool.query<AccountDbRow>(
      `
      SELECT id, code, currency, account_type, balance, version, seq, created_at, updated_at
      FROM accounts
      WHERE id = $1
      `,
      [accountId]
    );
    const row = res.rows[0];
    if (!row) {
      throw new AccountNotFoundError(accountId);
    }
    return mapAccountRow(row);
  }

  async getByCode(code: string): Promise<AccountRecord | null> {
    const res = await this.pool.query<AccountDbRow>(
      `
      SELECT id, code, currency, account_type, balance, version, seq, created_at, updated_at
      FROM accounts
      WHERE code = $1
      `,
      [code]
    );
    return res.rows[0] ? mapAccountRow(res.rows[0]) : null;
  }

  async getEntriesForAccount(accountId: string): Promise<LedgerEntryRecord[]> {
    const res = await this.pool.query<LedgerEntryDbRow>(
      `
      SELECT id, transaction_id, account_id, direction, amount, account_seq, balance_after, created_at
      FROM ledger_entries
      WHERE account_id = $1
      ORDER BY account_seq ASC
      `,
      [accountId]
    );
    return res.rows.map(mapEntryRow);
  }
}

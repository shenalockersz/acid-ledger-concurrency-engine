export type AccountType = "USER" | "SYSTEM" | "ESCROW";

export type EntryDirection = "DEBIT" | "CREDIT";

export interface AccountRecord {
  id: string;
  code: string;
  currency: string;
  accountType: AccountType;
  balance: bigint;
  version: number;
  seq: bigint;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateAccountInput {
  code: string;
  currency: string;
  accountType: AccountType;
  initialBalance?: bigint;
}

export interface TransferInput {
  fromAccountId: string;
  toAccountId: string;
  amount: bigint;
  currency: string;
  description: string;
  referenceId?: string;
}

export interface LedgerEntryRecord {
  id: string;
  transactionId: string;
  accountId: string;
  direction: EntryDirection;
  amount: bigint;
  accountSeq: bigint;
  balanceAfter: bigint;
  createdAt: Date;
}

export interface TransferResult {
  transactionId: string;
  fromAccountId: string;
  toAccountId: string;
  amount: bigint;
  currency: string;
  fromBalanceAfter: bigint;
  toBalanceAfter: bigint;
  strategy: "pessimistic" | "optimistic";
  attempts: number;
  createdAt: Date;
}

export interface TransferStrategy {
  readonly name: "pessimistic" | "optimistic";
  transfer(input: TransferInput): Promise<TransferResult>;
}

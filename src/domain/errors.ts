export class LedgerError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(message: string, code: string, statusCode: number) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.statusCode = statusCode;
  }
}

export class ValidationError extends LedgerError {
  constructor(message: string) {
    super(message, "VALIDATION_ERROR", 400);
  }
}

export class AccountNotFoundError extends LedgerError {
  constructor(accountId: string) {
    super(`Account not found: ${accountId}`, "ACCOUNT_NOT_FOUND", 404);
  }
}

export class CurrencyMismatchError extends LedgerError {
  constructor(message: string) {
    super(message, "CURRENCY_MISMATCH", 422);
  }
}

export class InsufficientFundsError extends LedgerError {
  constructor(accountId: string, available: bigint, requested: bigint) {
    super(
      `Insufficient funds on account ${accountId}: available=${available.toString()}, requested=${requested.toString()}`,
      "INSUFFICIENT_FUNDS",
      409
    );
  }
}

export class DuplicateReferenceError extends LedgerError {
  constructor(referenceId: string) {
    super(
      `Duplicate journal transaction referenceId: ${referenceId}`,
      "DUPLICATE_REFERENCE",
      409
    );
  }
}

export class OptimisticLockConflictError extends LedgerError {
  constructor(accountId: string) {
    super(
      `Optimistic concurrency conflict while updating account ${accountId}`,
      "OPTIMISTIC_LOCK_CONFLICT",
      409
    );
  }
}

export class IdempotencyPayloadMismatchError extends LedgerError {
  constructor(idempotencyKey: string) {
    super(
      `Idempotency-Key '${idempotencyKey}' was already used with a different request payload`,
      "IDEMPOTENCY_PAYLOAD_MISMATCH",
      422
    );
  }
}

export class IdempotencyInProgressError extends LedgerError {
  constructor(idempotencyKey: string) {
    super(
      `Request with Idempotency-Key '${idempotencyKey}' is currently in progress`,
      "IDEMPOTENCY_IN_PROGRESS",
      409
    );
  }
}

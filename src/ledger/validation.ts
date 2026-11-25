import { ValidationError } from "../domain/errors";
import { TransferInput } from "../domain/types";

const CURRENCY_REGEX = /^[A-Z]{3}$/;

/**
 * Validate transfer parameters before acquiring database locks or starting a transaction.
 */
export function validateTransferInput(input: TransferInput): void {
  if (!input.fromAccountId || input.fromAccountId.trim().length === 0) {
    throw new ValidationError("fromAccountId is required");
  }
  if (!input.toAccountId || input.toAccountId.trim().length === 0) {
    throw new ValidationError("toAccountId is required");
  }
  if (input.fromAccountId === input.toAccountId) {
    throw new ValidationError("fromAccountId and toAccountId must be different");
  }
  if (input.amount <= 0n) {
    throw new ValidationError("amount must be a positive integer in minor units");
  }
  if (!CURRENCY_REGEX.test(input.currency)) {
    throw new ValidationError("currency must be a 3-letter uppercase ISO code");
  }
  if (!input.description || input.description.trim().length === 0) {
    throw new ValidationError("description is required");
  }
}

/**
 * Return account IDs in deterministic ascending order so concurrent bidirectional
 * transfers (A -> B and B -> A) always lock rows in the same order and avoid deadlocks.
 */
export function sortAccountIdsForLocking(firstId: string, secondId: string): [string, string] {
  return firstId < secondId ? [firstId, secondId] : [secondId, firstId];
}

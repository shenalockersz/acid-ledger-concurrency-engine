import { Pool } from "pg";
import { TransferInput, TransferResult } from "../domain/types";
import {
  OptimisticTransferOptions,
  OptimisticTransferStrategy,
} from "./optimistic-transfer.strategy";
import { PessimisticTransferStrategy } from "./pessimistic-transfer.strategy";

export type LockingStrategyName = "pessimistic" | "optimistic";

export class TransferService {
  private readonly pessimistic: PessimisticTransferStrategy;
  private readonly optimistic: OptimisticTransferStrategy;

  constructor(pool: Pool, optimisticOptions?: OptimisticTransferOptions) {
    this.pessimistic = new PessimisticTransferStrategy(pool);
    this.optimistic = new OptimisticTransferStrategy(pool, optimisticOptions);
  }

  async transfer(
    input: TransferInput,
    strategy: LockingStrategyName = "pessimistic"
  ): Promise<TransferResult> {
    if (strategy === "optimistic") {
      return this.optimistic.transfer(input);
    }
    return this.pessimistic.transfer(input);
  }
}

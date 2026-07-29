import type { OperationsContext } from "../operations.js";
import type { ErrorHubDatabase } from "../storage/database.js";
import {
  readRetentionMutationRevision,
  readRetentionStorageAccounting,
} from "./accounting.js";
import type { PhysicalStorageUsage } from "./storage-budget.js";

export interface PhysicalSafetyMonitorOptions {
  readonly database: ErrorHubDatabase;
  readonly operations: OperationsContext;
  readonly readPhysicalUsage: () =>
    | PhysicalStorageUsage
    | Promise<PhysicalStorageUsage>;
}

export class PhysicalSafetyMonitor {
  public constructor(private readonly options: PhysicalSafetyMonitorOptions) {}

  public async sample(): Promise<boolean> {
    const before = readRetentionMutationRevision(this.options.database);
    const physical = await this.options.readPhysicalUsage();
    const accounting = readRetentionStorageAccounting(this.options.database);
    if (accounting.mutationRevision !== before) {
      this.options.operations.storageSafety.observePhysicalUsage(physical);
      return false;
    }
    this.options.operations.storageSafety.observeUsage(
      physical,
      accounting.logicalPayloadBytes,
      accounting.oldestEventReceivedAt,
    );
    return true;
  }
}

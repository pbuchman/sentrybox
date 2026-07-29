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
  readonly readPhysicalUsage: (
    signal?: AbortSignal,
  ) => PhysicalStorageUsage | Promise<PhysicalStorageUsage>;
  readonly now?: () => Date;
}

export class PhysicalSafetyMonitor {
  public constructor(private readonly options: PhysicalSafetyMonitorOptions) {}

  public async sample(signal?: AbortSignal): Promise<boolean> {
    try {
      throwIfAborted(signal);
      const before = readRetentionMutationRevision(this.options.database);
      const physical = await abortableSample(
        this.options.readPhysicalUsage(signal),
        signal,
      );
      throwIfAborted(signal);
      const accounting = readRetentionStorageAccounting(this.options.database);
      if (accounting.mutationRevision !== before) {
        this.options.operations.storageSafety.observePhysicalUsage(physical);
        this.options.operations.metrics.recordPhysicalMonitor("unstable");
        return false;
      }
      this.options.operations.storageSafety.observeUsage(
        physical,
        accounting.logicalPayloadBytes,
        accounting.oldestEventReceivedAt,
      );
      this.options.operations.storageSafety.markPhysicalMonitorSuccess(
        this.now(),
      );
      this.options.operations.metrics.recordPhysicalMonitor("success");
      return true;
    } catch (error) {
      if (signal?.aborted === true) throw error;
      this.options.operations.storageSafety.markPhysicalMonitorFailure(
        this.now(),
      );
      this.options.operations.metrics.recordPhysicalMonitor("failure");
      throw error;
    }
  }

  private now(): Date {
    return (this.options.now ?? (() => new Date()))();
  }
}

async function abortableSample<T>(
  value: T | Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (signal === undefined) return value;
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(value).then(
      (result) => {
        signal.removeEventListener("abort", onAbort);
        resolve(result);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw signal.reason;
}

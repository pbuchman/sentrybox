import { ErrorHubMetrics } from "./metrics.js";
import {
  DEFAULT_RETENTION_CONFIG,
  type RetentionConfig,
  StorageSafetyState,
} from "./retention/storage-budget.js";

export interface OperationsContext {
  readonly storageSafety: StorageSafetyState;
  readonly metrics: ErrorHubMetrics;
}

export function createOperationsContext(
  retentionConfig: RetentionConfig = DEFAULT_RETENTION_CONFIG,
): OperationsContext {
  return {
    storageSafety: new StorageSafetyState(retentionConfig),
    metrics: new ErrorHubMetrics(),
  };
}

import { ErrorHubMetrics } from "./metrics.js";
import {
  DEFAULT_RETENTION_CONFIG,
  type RetentionConfig,
  StorageSafetyState,
  validateRetentionConfig,
} from "./retention/storage-budget.js";

const operationsContextBrand: unique symbol = Symbol("OperationsContext");

export interface OperationsContext {
  readonly [operationsContextBrand]: true;
  readonly retentionConfig: RetentionConfig;
  readonly storageSafety: StorageSafetyState;
  readonly metrics: ErrorHubMetrics;
}

export function createOperationsContext(
  retentionConfig: RetentionConfig = DEFAULT_RETENTION_CONFIG,
): OperationsContext {
  const validatedConfig = validateRetentionConfig(retentionConfig);
  return Object.freeze({
    [operationsContextBrand]: true as const,
    retentionConfig: validatedConfig,
    storageSafety: new StorageSafetyState(validatedConfig),
    metrics: new ErrorHubMetrics(),
  });
}

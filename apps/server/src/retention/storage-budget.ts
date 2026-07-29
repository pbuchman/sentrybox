export interface RetentionConfig {
  readonly eventAgeMs: number;
  readonly deliveryTtlMs: number;
  readonly logicalHighBytes: number;
  readonly logicalTargetBytes: number;
  readonly physicalCriticalBytes: number;
  readonly physicalTotalBytes: number;
  readonly minimumFreeBytes: number;
  readonly batchSize: number;
  readonly incrementalVacuumPages: number;
}

const GIB = 1024 ** 3;

export const DEFAULT_RETENTION_CONFIG: RetentionConfig = {
  eventAgeMs: 30 * 24 * 60 * 60_000,
  deliveryTtlMs: 7 * 24 * 60 * 60_000,
  logicalHighBytes: 4 * GIB,
  logicalTargetBytes: 3.6 * GIB,
  physicalCriticalBytes: 4.75 * GIB,
  physicalTotalBytes: 5 * GIB,
  minimumFreeBytes: 256 * 1024 ** 2,
  batchSize: 500,
  incrementalVacuumPages: 1_000,
};

export interface PhysicalStorageUsage {
  readonly databaseBytes: number;
  readonly walBytes: number;
  readonly shmBytes: number;
  readonly temporaryBytes: number;
  readonly dataDirectoryOtherBytes: number;
  readonly totalBytes: number;
  readonly freeBytes: number;
}

export type StorageSafety = "unknown" | "safe" | "high" | "critical" | "unsafe";

export interface StorageSafetySnapshot {
  readonly safety: StorageSafety;
  readonly acceptingIngest: boolean;
  readonly retentionKnownSuccessful: boolean;
  readonly lastRun: string | null;
  readonly lastFailure: string | null;
  readonly physicalUsage: PhysicalStorageUsage | null;
  readonly logicalPayloadBytes: number | null;
  readonly oldestEventReceivedAt: string | null;
  readonly removedEvents: {
    readonly age: number;
    readonly budget: number;
  };
}

export class StorageSafetyState {
  readonly #config: RetentionConfig;
  #snapshot: StorageSafetySnapshot = {
    safety: "unknown",
    acceptingIngest: false,
    retentionKnownSuccessful: false,
    lastRun: null,
    lastFailure: null,
    physicalUsage: null,
    logicalPayloadBytes: null,
    oldestEventReceivedAt: null,
    removedEvents: { age: 0, budget: 0 },
  };

  public constructor(config: RetentionConfig = DEFAULT_RETENTION_CONFIG) {
    this.#config = validateRetentionConfig(config);
  }

  public snapshot(): StorageSafetySnapshot {
    return {
      ...this.#snapshot,
      physicalUsage:
        this.#snapshot.physicalUsage === null
          ? null
          : { ...this.#snapshot.physicalUsage },
      removedEvents: { ...this.#snapshot.removedEvents },
    };
  }

  public observeUsage(
    physicalUsage: PhysicalStorageUsage,
    logicalPayloadBytes: number,
    oldestEventReceivedAt: string | null,
  ): void {
    const physical = validatePhysicalUsage(physicalUsage);
    const logical = nonNegativeNumber(
      logicalPayloadBytes,
      "logical payload bytes",
    );
    if (
      oldestEventReceivedAt !== null &&
      !Number.isFinite(Date.parse(oldestEventReceivedAt))
    ) {
      throw new TypeError("oldest event timestamp must be valid");
    }
    const observedSafety = classifyStorage(this.#config, physical, logical);
    const publishObservedSafety =
      observedSafety === "critical" || this.#snapshot.retentionKnownSuccessful;
    this.#snapshot = {
      ...this.#snapshot,
      safety: publishObservedSafety ? observedSafety : this.#snapshot.safety,
      acceptingIngest:
        publishObservedSafety && observedSafety !== "critical"
          ? this.#snapshot.retentionKnownSuccessful
          : false,
      physicalUsage: physical,
      logicalPayloadBytes: logical,
      oldestEventReceivedAt,
    };
  }

  public markSuccess(
    completedAt: Date,
    removedEvents: { readonly age: number; readonly budget: number },
  ): void {
    const timestamp = validDate(
      completedAt,
      "retention completion",
    ).toISOString();
    const physical = this.#snapshot.physicalUsage;
    const logical = this.#snapshot.logicalPayloadBytes;
    if (physical === null || logical === null) {
      throw new Error("retention success requires sampled storage usage");
    }
    const safety = classifyStorage(this.#config, physical, logical);
    this.#snapshot = {
      ...this.#snapshot,
      safety,
      acceptingIngest: safety === "safe" || safety === "high",
      retentionKnownSuccessful: true,
      lastRun: timestamp,
      lastFailure: null,
      removedEvents: {
        age: nonNegativeInteger(removedEvents.age, "age removals"),
        budget: nonNegativeInteger(removedEvents.budget, "budget removals"),
      },
    };
  }

  public markFailure(reason: string, completedAt: Date): void {
    if (reason.length === 0) {
      throw new TypeError("retention failure reason must not be empty");
    }
    const safety: StorageSafety =
      reason === "physical_storage_critical" ||
      this.#snapshot.safety === "critical"
        ? "critical"
        : "unsafe";
    this.#snapshot = {
      ...this.#snapshot,
      safety,
      acceptingIngest: false,
      retentionKnownSuccessful: false,
      lastRun: validDate(completedAt, "retention failure").toISOString(),
      lastFailure: reason,
    };
  }
}

export function validateRetentionConfig(
  config: RetentionConfig,
): RetentionConfig {
  for (const [field, value] of Object.entries(config)) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new TypeError(`${field} must be positive`);
    }
  }
  if (config.logicalTargetBytes >= config.logicalHighBytes) {
    throw new TypeError("logical target must be below the high-water mark");
  }
  if (config.logicalHighBytes >= config.physicalCriticalBytes) {
    throw new TypeError(
      "logical high-water mark must be below physical critical usage",
    );
  }
  if (config.physicalCriticalBytes >= config.physicalTotalBytes) {
    throw new TypeError(
      "physical critical usage must be below the total budget",
    );
  }
  if (
    !Number.isSafeInteger(config.batchSize) ||
    !Number.isSafeInteger(config.incrementalVacuumPages)
  ) {
    throw new TypeError(
      "retention batch and vacuum bounds must be safe integers",
    );
  }
  return Object.isFrozen(config) ? config : Object.freeze({ ...config });
}

function classifyStorage(
  config: RetentionConfig,
  physical: PhysicalStorageUsage,
  logical: number,
): StorageSafety {
  if (
    physical.totalBytes >= config.physicalCriticalBytes ||
    physical.freeBytes < config.minimumFreeBytes
  ) {
    return "critical";
  }
  if (logical > config.logicalHighBytes) return "critical";
  if (
    logical === config.logicalHighBytes ||
    physical.totalBytes >= config.logicalHighBytes
  ) {
    return "high";
  }
  return "safe";
}

function validatePhysicalUsage(
  usage: PhysicalStorageUsage,
): PhysicalStorageUsage {
  for (const [field, value] of Object.entries(usage)) {
    nonNegativeNumber(value, field);
  }
  return { ...usage };
}

function nonNegativeNumber(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative finite number`);
  }
  return value;
}

function nonNegativeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative safe integer`);
  }
  return value;
}

function validDate(value: Date, field: string): Date {
  if (!Number.isFinite(value.getTime())) {
    throw new TypeError(`${field} timestamp must be valid`);
  }
  return new Date(value.getTime());
}

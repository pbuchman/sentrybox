import { MAX_DECOMPRESSED_ENVELOPE_BYTES } from "@sentrybox/protocol";

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

/**
 * One admitted event can originate from at most a 1 MiB decompressed envelope.
 * Four times that bound reserves room for the retained payload plus bounded
 * SQLite database/WAL page duplication, indexes, facets, and one outbox row.
 */
export const MAX_UNMEASURED_EVENT_PHYSICAL_BYTES =
  4 * MAX_DECOMPRESSED_ENVELOPE_BYTES;

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
  readonly unmeasuredIngestBytes: number;
  readonly physicalMonitor: {
    readonly healthy: boolean | null;
    readonly lastRun: string | null;
    readonly lastSuccess: string | null;
    readonly lastFailure: string | null;
    readonly consecutiveFailures: number;
  };
  readonly removedEvents: {
    readonly age: number;
    readonly budget: number;
  };
}

export interface IngestStorageReservation {
  release(unusedUnits?: number): void;
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
    unmeasuredIngestBytes: 0,
    physicalMonitor: {
      healthy: null,
      lastRun: null,
      lastSuccess: null,
      lastFailure: null,
      consecutiveFailures: 0,
    },
    removedEvents: { age: 0, budget: 0 },
  };
  #reservationEpoch = 0;

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
      physicalMonitor: { ...this.#snapshot.physicalMonitor },
    };
  }

  public beginVerification(): void {
    this.#snapshot = {
      ...this.#snapshot,
      acceptingIngest: false,
      retentionKnownSuccessful: false,
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
    this.#reservationEpoch += 1;
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
      unmeasuredIngestBytes: 0,
    };
  }

  public reserveIngest(units = 1): IngestStorageReservation | null {
    if (!Number.isSafeInteger(units) || units <= 0) {
      throw new TypeError("ingest reservation units must be positive");
    }
    const reservationBytes = this.reservationBytes(units);
    if (!this.canReserve(reservationBytes)) {
      this.#snapshot = { ...this.#snapshot, acceptingIngest: false };
      return null;
    }
    const epoch = this.#reservationEpoch;
    this.#snapshot = {
      ...this.#snapshot,
      unmeasuredIngestBytes:
        this.#snapshot.unmeasuredIngestBytes + reservationBytes,
    };
    this.#snapshot = {
      ...this.#snapshot,
      acceptingIngest: this.canReserve(this.reservationBytes(1)),
    };
    let releasableUnits = units;
    return {
      release: (unusedUnits = releasableUnits): void => {
        if (
          !Number.isSafeInteger(unusedUnits) ||
          unusedUnits < 0 ||
          unusedUnits > releasableUnits
        ) {
          throw new TypeError("unused ingest reservation units are invalid");
        }
        releasableUnits -= unusedUnits;
        if (this.#reservationEpoch !== epoch || unusedUnits === 0) return;
        this.#snapshot = {
          ...this.#snapshot,
          unmeasuredIngestBytes:
            this.#snapshot.unmeasuredIngestBytes -
            this.reservationBytes(unusedUnits),
        };
        this.#snapshot = {
          ...this.#snapshot,
          acceptingIngest: this.canReserve(this.reservationBytes(1)),
        };
      },
    };
  }

  public observePhysicalUsage(physicalUsage: PhysicalStorageUsage): void {
    const physical = validatePhysicalUsage(physicalUsage);
    const physicallyCritical =
      physical.totalBytes >= this.#config.physicalCriticalBytes ||
      physical.freeBytes < this.#config.minimumFreeBytes;
    this.#snapshot = {
      ...this.#snapshot,
      safety: physicallyCritical ? "critical" : this.#snapshot.safety,
      acceptingIngest: false,
      physicalUsage: physical,
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

  public markPhysicalMonitorFailure(completedAt: Date): void {
    const timestamp = validDate(
      completedAt,
      "physical monitor failure",
    ).toISOString();
    this.#snapshot = {
      ...this.#snapshot,
      safety: this.#snapshot.safety === "critical" ? "critical" : "unsafe",
      acceptingIngest: false,
      physicalMonitor: {
        ...this.#snapshot.physicalMonitor,
        healthy: false,
        lastRun: timestamp,
        lastFailure: timestamp,
        consecutiveFailures: Math.min(
          Number.MAX_SAFE_INTEGER,
          this.#snapshot.physicalMonitor.consecutiveFailures + 1,
        ),
      },
    };
  }

  public markPhysicalMonitorSuccess(completedAt: Date): void {
    const timestamp = validDate(
      completedAt,
      "physical monitor success",
    ).toISOString();
    this.#snapshot = {
      ...this.#snapshot,
      physicalMonitor: {
        ...this.#snapshot.physicalMonitor,
        healthy: true,
        lastRun: timestamp,
        lastSuccess: timestamp,
        consecutiveFailures: 0,
      },
    };
  }

  private reservationBytes(units: number): number {
    const bytes = MAX_UNMEASURED_EVENT_PHYSICAL_BYTES * units;
    if (!Number.isSafeInteger(bytes) || bytes <= 0) {
      throw new RangeError("ingest reservation bytes exceed the safe range");
    }
    return bytes;
  }

  private canReserve(bytes: number): boolean {
    const physical = this.#snapshot.physicalUsage;
    const logical = this.#snapshot.logicalPayloadBytes;
    if (
      !this.#snapshot.retentionKnownSuccessful ||
      physical === null ||
      logical === null ||
      logical > this.#config.logicalHighBytes
    ) {
      return false;
    }
    return (
      physical.totalBytes + this.#snapshot.unmeasuredIngestBytes + bytes <
        this.#config.physicalCriticalBytes &&
      physical.freeBytes - this.#snapshot.unmeasuredIngestBytes - bytes >=
        this.#config.minimumFreeBytes
    );
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

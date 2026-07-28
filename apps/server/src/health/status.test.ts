import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type ErrorHubDatabase } from "../storage/database.js";
import { migrateDatabase } from "../storage/migrate.js";
import {
  DEFAULT_RETENTION_CONFIG,
  StorageSafetyState,
  type PhysicalStorageUsage,
} from "../retention/storage-budget.js";
import { RetentionSweeper } from "../retention/sweeper.js";
import {
  createOperationsContext,
  type OperationsContext,
} from "../operations.js";
import { HealthStatusService } from "./status.js";

const NOW = "2026-08-28T10:00:00.000Z";
let database: ErrorHubDatabase;
let safetyState: StorageSafetyState;
let operations: OperationsContext;
let health: HealthStatusService;

beforeEach(() => {
  database = openDatabase(":memory:");
  migrateDatabase(database, "2026-07-28T00:00:00.000Z");
  operations = createOperationsContext(DEFAULT_RETENTION_CONFIG);
  safetyState = operations.storageSafety;
  health = new HealthStatusService({ database, safetyState });
});

afterEach(() => {
  database.close();
});

describe("HealthStatusService", () => {
  it("keeps liveness process-only while readiness requires a known successful retention sample", async () => {
    expect(health.liveness()).toEqual({ status: "ok" });
    expect(health.readiness()).toMatchObject({
      ready: false,
      checks: {
        sqliteReadWrite: true,
        migrationCurrent: true,
        retentionKnownSuccessful: false,
      },
    });

    await successfulRetention();

    expect(health.readiness()).toMatchObject({
      ready: true,
      checks: {
        sqliteReadWrite: true,
        migrationCurrent: true,
        retentionKnownSuccessful: true,
        logicalWithinLimit: true,
        physicalWithinLimit: true,
        freeSpaceAvailable: true,
      },
    });
  });

  it("checks both SQLite write access and current migration version", async () => {
    await successfulRetention();
    database.pragma("query_only = ON");
    expect(health.readiness()).toMatchObject({
      ready: false,
      checks: { sqliteReadWrite: false },
    });
    database.pragma("query_only = OFF");
    database.pragma("user_version = 4");
    expect(health.readiness()).toMatchObject({
      ready: false,
      checks: { migrationCurrent: false },
    });
  });

  it("requires a later successful run and resample before recovering from critical or failed storage", async () => {
    const critical = physical({
      totalBytes: DEFAULT_RETENTION_CONFIG.physicalCriticalBytes,
    });
    const criticalRun = new RetentionSweeper({
      database,
      operations,
      clock: () => new Date(NOW),
      readPhysicalUsage: () => critical,
    });
    await criticalRun.run();
    expect(health.readiness().ready).toBe(false);

    safetyState.markFailure("cleanup_failed", new Date(NOW));
    safetyState.observeUsage(physical(), 0, null);
    expect(health.readiness()).toMatchObject({
      ready: false,
      checks: { retentionKnownSuccessful: false },
    });

    await successfulRetention();
    expect(health.readiness().ready).toBe(true);
  });

  it("reports storage, retention, ingest, outbox, and redrive state without payload data", async () => {
    await successfulRetention();
    const status = health.systemStatus();

    expect(status).toMatchObject({
      status: "ok",
      database: { ready: true, migrationCurrent: true },
      storage: {
        physicalBytes: 135,
        logicalPayloadBytes: 0,
        budgetBytes: DEFAULT_RETENTION_CONFIG.physicalTotalBytes,
        safety: "safe",
      },
      retention: {
        knownSuccessful: true,
        lastRun: NOW,
      },
      ingest: { accepting: true },
      outbox: {
        pending: 0,
        retry: 0,
        delivered: 0,
        deadLetter: 0,
        suppressed: 0,
      },
      redrives: { pending: 0, delivered: 0, deadLetter: 0 },
    });
    expect(JSON.stringify(status)).not.toMatch(
      /target_url|secret_ref|last_error|body/u,
    );
  });

  async function successfulRetention(): Promise<void> {
    await new RetentionSweeper({
      database,
      operations,
      clock: () => new Date(NOW),
      readPhysicalUsage: () => physical(),
    }).run();
  }
});

function physical(
  overrides: Partial<PhysicalStorageUsage> = {},
): PhysicalStorageUsage {
  return {
    databaseBytes: 100,
    walBytes: 20,
    shmBytes: 10,
    temporaryBytes: 5,
    dataDirectoryOtherBytes: 0,
    totalBytes: 135,
    freeBytes: 10 * 1024 ** 3,
    ...overrides,
  };
}

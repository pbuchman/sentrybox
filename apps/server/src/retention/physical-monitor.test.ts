import { afterEach, describe, expect, it } from "vitest";
import { createOperationsContext } from "../operations.js";
import { openDatabase, type ErrorHubDatabase } from "../storage/database.js";
import { migrateDatabase } from "../storage/migrate.js";
import { PhysicalSafetyMonitor } from "./physical-monitor.js";
import { HealthStatusService } from "../health/status.js";
import type {
  PhysicalStorageUsage,
  RetentionConfig,
} from "./storage-budget.js";
import {
  DEFAULT_RETENTION_CONFIG,
  MAX_UNMEASURED_EVENT_PHYSICAL_BYTES,
} from "./storage-budget.js";

const databases: ErrorHubDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0).reverse()) database.close();
});

describe("physical safety monitor and unmeasured ingest headroom", () => {
  it("uses a bounded event-growth estimate while preserving the critical-to-total safety buffer", () => {
    const config = reservationConfig();
    const operations = createOperationsContext(config);
    operations.storageSafety.observeUsage(
      usage(config.physicalCriticalBytes - MAX_UNMEASURED_EVENT_PHYSICAL_BYTES),
      0,
      null,
    );
    operations.storageSafety.markSuccess(new Date(0), { age: 0, budget: 0 });

    expect(operations.storageSafety.reserveIngest()).toBeNull();
    operations.storageSafety.observeUsage(
      usage(
        config.physicalCriticalBytes - MAX_UNMEASURED_EVENT_PHYSICAL_BYTES - 1,
      ),
      0,
      null,
    );
    const first = operations.storageSafety.reserveIngest();

    expect(first).not.toBeNull();
    expect(operations.storageSafety.snapshot()).toMatchObject({
      acceptingIngest: false,
      unmeasuredIngestBytes: MAX_UNMEASURED_EVENT_PHYSICAL_BYTES,
    });
    expect(operations.storageSafety.reserveIngest()).toBeNull();
    first?.release();
    expect(operations.storageSafety.snapshot()).toMatchObject({
      acceptingIngest: true,
      unmeasuredIngestBytes: 0,
    });
  });

  it("admits a realistic default burst and bounds multiple-event reservations", () => {
    const operations = createOperationsContext(DEFAULT_RETENTION_CONFIG);
    operations.storageSafety.observeUsage(usage(0), 0, null);
    operations.storageSafety.markSuccess(new Date(0), { age: 0, budget: 0 });

    const burst = Array.from({ length: 20 }, () =>
      operations.storageSafety.reserveIngest(),
    );

    expect(burst.every((reservation) => reservation !== null)).toBe(true);
    expect(operations.storageSafety.snapshot().unmeasuredIngestBytes).toBe(
      20 * MAX_UNMEASURED_EVENT_PHYSICAL_BYTES,
    );
    const multi = operations.storageSafety.reserveIngest(3);
    expect(multi).not.toBeNull();
    expect(operations.storageSafety.snapshot().unmeasuredIngestBytes).toBe(
      23 * MAX_UNMEASURED_EVENT_PHYSICAL_BYTES,
    );
    multi?.release(2);
    expect(operations.storageSafety.snapshot().unmeasuredIngestBytes).toBe(
      21 * MAX_UNMEASURED_EVENT_PHYSICAL_BYTES,
    );

    const nearHighWater = createOperationsContext(DEFAULT_RETENTION_CONFIG);
    nearHighWater.storageSafety.observeUsage(usage(4 * 1024 ** 3), 0, null);
    nearHighWater.storageSafety.markSuccess(new Date(0), {
      age: 0,
      budget: 0,
    });
    expect(
      Array.from({ length: 3 }, () =>
        nearHighWater.storageSafety.reserveIngest(),
      ).every((reservation) => reservation !== null),
    ).toBe(true);
  });

  it("invalidates old reservation releases after a stable sample without underflow", () => {
    const operations = createOperationsContext(DEFAULT_RETENTION_CONFIG);
    operations.storageSafety.observeUsage(usage(0), 0, null);
    operations.storageSafety.markSuccess(new Date(0), { age: 0, budget: 0 });
    const reservation = operations.storageSafety.reserveIngest(2);
    expect(reservation).not.toBeNull();

    operations.storageSafety.observeUsage(usage(0), 0, null);
    reservation?.release(2);

    expect(operations.storageSafety.snapshot()).toMatchObject({
      acceptingIngest: true,
      unmeasuredIngestBytes: 0,
    });
  });

  it("clears reservations only after a revision-stable lightweight physical sample", async () => {
    const database = openDatabase(":memory:");
    databases.push(database);
    migrateDatabase(database, "2026-07-29T12:00:00.000Z");
    const operations = createOperationsContext(tinyConfig());
    operations.storageSafety.observeUsage(usage(449), 0, null);
    operations.storageSafety.markSuccess(new Date(0), { age: 0, budget: 0 });
    expect(operations.storageSafety.reserveIngest()).not.toBeNull();
    let completeSample: ((value: PhysicalStorageUsage) => void) | undefined;
    const physical = new Promise<PhysicalStorageUsage>((resolve) => {
      completeSample = resolve;
    });
    const monitor = new PhysicalSafetyMonitor({
      database,
      operations,
      readPhysicalUsage: () => physical,
    });

    const pending = monitor.sample();
    database
      .prepare(
        "UPDATE retention_accounting SET mutation_revision = mutation_revision + 1 WHERE singleton = 1",
      )
      .run();
    completeSample?.(usage(449));

    await expect(pending).resolves.toBe(false);
    expect(operations.storageSafety.snapshot()).toMatchObject({
      acceptingIngest: false,
      unmeasuredIngestBytes: MAX_UNMEASURED_EVENT_PHYSICAL_BYTES,
    });
    await expect(
      new PhysicalSafetyMonitor({
        database,
        operations,
        readPhysicalUsage: () => usage(449),
      }).sample(),
    ).resolves.toBe(true);
    expect(operations.storageSafety.snapshot()).toMatchObject({
      acceptingIngest: true,
      unmeasuredIngestBytes: 0,
    });
    expect(
      database
        .prepare(
          "SELECT reconciliation_cursor_id FROM retention_accounting WHERE singleton = 1",
        )
        .get(),
    ).toEqual({ reconciliation_cursor_id: -1 });
  });

  it("fails closed and exposes a bounded failure signal until a stable safe sample recovers", async () => {
    const database = openDatabase(":memory:");
    databases.push(database);
    migrateDatabase(database, "2026-07-29T12:00:00.000Z");
    const operations = createOperationsContext(DEFAULT_RETENTION_CONFIG);
    operations.storageSafety.observeUsage(usage(0), 0, null);
    operations.storageSafety.markSuccess(new Date(0), { age: 0, budget: 0 });
    const failureSecret = "sampler-secret-must-not-leak";
    const monitor = new PhysicalSafetyMonitor({
      database,
      operations,
      readPhysicalUsage: () => {
        throw new Error(failureSecret);
      },
    });

    await expect(monitor.sample()).rejects.toThrow(failureSecret);

    const health = new HealthStatusService({ database, operations });
    expect(health.readiness()).toMatchObject({
      ready: false,
      checks: { ingestAccepting: false },
    });
    const status = health.systemStatus();
    expect(status).toMatchObject({
      status: "critical",
      physicalMonitor: {
        healthy: false,
        consecutiveFailures: 1,
        lastFailure: expect.any(String),
      },
    });
    expect(JSON.stringify(status)).not.toContain(failureSecret);
    expect(
      operations.metrics.render({
        database,
        storage: operations.storageSafety,
      }),
    ).toContain(
      'sentrybox_physical_monitor_samples_total{outcome="failure"} 1',
    );

    await expect(
      new PhysicalSafetyMonitor({
        database,
        operations,
        readPhysicalUsage: () => usage(0),
      }).sample(),
    ).resolves.toBe(true);
    expect(health.readiness().ready).toBe(true);
    expect(health.systemStatus()).toMatchObject({
      physicalMonitor: { healthy: true, consecutiveFailures: 0 },
    });
  });

  it("does not let a monitor sample establish retention safety on its own", async () => {
    const database = openDatabase(":memory:");
    databases.push(database);
    migrateDatabase(database, "2026-07-29T12:00:00.000Z");
    const operations = createOperationsContext(DEFAULT_RETENTION_CONFIG);

    await expect(
      new PhysicalSafetyMonitor({
        database,
        operations,
        readPhysicalUsage: () => usage(0),
      }).sample(),
    ).resolves.toBe(true);

    expect(operations.storageSafety.snapshot()).toMatchObject({
      acceptingIngest: false,
      retentionKnownSuccessful: false,
    });
  });
});

function reservationConfig(): RetentionConfig {
  return {
    eventAgeMs: 1_000,
    deliveryTtlMs: 1_000,
    logicalHighBytes: MAX_UNMEASURED_EVENT_PHYSICAL_BYTES,
    logicalTargetBytes: MAX_UNMEASURED_EVENT_PHYSICAL_BYTES - 1,
    physicalCriticalBytes: 4 * MAX_UNMEASURED_EVENT_PHYSICAL_BYTES,
    physicalTotalBytes:
      4 * MAX_UNMEASURED_EVENT_PHYSICAL_BYTES + 256 * 1024 ** 2,
    minimumFreeBytes: 1,
    batchSize: 1,
    incrementalVacuumPages: 1,
  };
}

function tinyConfig(): RetentionConfig {
  return {
    eventAgeMs: 1_000,
    deliveryTtlMs: 1_000,
    logicalHighBytes: 2 * MAX_UNMEASURED_EVENT_PHYSICAL_BYTES,
    logicalTargetBytes: 2 * MAX_UNMEASURED_EVENT_PHYSICAL_BYTES - 1,
    physicalCriticalBytes: 4 * MAX_UNMEASURED_EVENT_PHYSICAL_BYTES,
    physicalTotalBytes:
      4 * MAX_UNMEASURED_EVENT_PHYSICAL_BYTES + 256 * 1024 ** 2,
    minimumFreeBytes: 10,
    batchSize: 1,
    incrementalVacuumPages: 1,
  };
}

function usage(totalBytes: number): PhysicalStorageUsage {
  return {
    databaseBytes: totalBytes,
    walBytes: 0,
    shmBytes: 0,
    temporaryBytes: 0,
    dataDirectoryOtherBytes: 0,
    totalBytes,
    freeBytes: 10 * 1024 ** 3,
  };
}

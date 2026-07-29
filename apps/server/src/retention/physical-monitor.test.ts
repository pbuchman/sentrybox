import { afterEach, describe, expect, it } from "vitest";
import { createOperationsContext } from "../operations.js";
import { openDatabase, type ErrorHubDatabase } from "../storage/database.js";
import { migrateDatabase } from "../storage/migrate.js";
import { PhysicalSafetyMonitor } from "./physical-monitor.js";
import type {
  PhysicalStorageUsage,
  RetentionConfig,
} from "./storage-budget.js";

const databases: ErrorHubDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0).reverse()) database.close();
});

describe("physical safety monitor and unmeasured ingest headroom", () => {
  it("reserves the entire critical-to-total buffer per unmeasured ingest", () => {
    const operations = createOperationsContext(tinyConfig());
    operations.storageSafety.observeUsage(usage(449), 0, null);
    operations.storageSafety.markSuccess(new Date(0), { age: 0, budget: 0 });

    const first = operations.storageSafety.reserveIngest();

    expect(first).not.toBeNull();
    expect(operations.storageSafety.snapshot()).toMatchObject({
      acceptingIngest: false,
      unmeasuredIngestBytes: 25,
    });
    expect(operations.storageSafety.reserveIngest()).toBeNull();
    first?.release();
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
      unmeasuredIngestBytes: 25,
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
});

function tinyConfig(): RetentionConfig {
  return {
    eventAgeMs: 1_000,
    deliveryTtlMs: 1_000,
    logicalHighBytes: 400,
    logicalTargetBytes: 360,
    physicalCriticalBytes: 475,
    physicalTotalBytes: 500,
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
    freeBytes: 1_000,
  };
}

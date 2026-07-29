import type { ErrorHubDatabase } from "../storage/database.js";
import { CURRENT_MIGRATION_VERSION } from "../storage/migrate.js";
import {
  type RetentionConfig,
  type StorageSafetyState,
} from "../retention/storage-budget.js";
import type { OperationsContext } from "../operations.js";

export interface ReadinessChecks {
  readonly sqliteReadWrite: boolean;
  readonly migrationCurrent: boolean;
  readonly retentionKnownSuccessful: boolean;
  readonly logicalWithinLimit: boolean;
  readonly physicalWithinLimit: boolean;
  readonly freeSpaceAvailable: boolean;
  readonly ingestAccepting: boolean;
}

export interface ReadinessResult {
  readonly ready: boolean;
  readonly checks: ReadinessChecks;
}

export interface HealthStatusServiceOptions {
  readonly database: ErrorHubDatabase;
  readonly operations: OperationsContext;
}

export class HealthStatusService {
  readonly #database: ErrorHubDatabase;
  readonly #safetyState: StorageSafetyState;
  readonly #config: RetentionConfig;

  public constructor(options: HealthStatusServiceOptions) {
    this.#database = options.database;
    this.#safetyState = options.operations.storageSafety;
    this.#config = options.operations.retentionConfig;
  }

  public liveness(): { readonly status: "ok" } {
    return { status: "ok" };
  }

  public readiness(): ReadinessResult {
    const snapshot = this.#safetyState.snapshot();
    const logical = snapshot.logicalPayloadBytes;
    const physical = snapshot.physicalUsage;
    const checks: ReadinessChecks = {
      sqliteReadWrite: sqliteReadWrite(this.#database),
      migrationCurrent: migrationCurrent(this.#database),
      retentionKnownSuccessful: snapshot.retentionKnownSuccessful,
      logicalWithinLimit:
        logical !== null && logical <= this.#config.logicalHighBytes,
      physicalWithinLimit:
        physical !== null &&
        physical.totalBytes < this.#config.physicalCriticalBytes &&
        physical.totalBytes < this.#config.physicalTotalBytes,
      freeSpaceAvailable:
        physical !== null &&
        physical.freeBytes >= this.#config.minimumFreeBytes,
      ingestAccepting: snapshot.acceptingIngest,
    };
    return {
      ready: Object.values(checks).every((value) => value === true),
      checks,
    };
  }

  public systemStatus(): Readonly<Record<string, unknown>> {
    const readiness = this.readiness();
    const snapshot = this.#safetyState.snapshot();
    const physical = snapshot.physicalUsage;
    const outbox = stateCounts(this.#database, "webhook_outbox", [
      "pending",
      "retry",
      "delivered",
      "dead_letter",
      "suppressed",
    ] as const);
    const redrives = stateCounts(this.#database, "webhook_redrives", [
      "pending",
      "delivered",
      "dead_letter",
    ] as const);
    return {
      status: readiness.ready
        ? "ok"
        : snapshot.safety === "critical" || snapshot.safety === "unsafe"
          ? "critical"
          : "not_ready",
      database: {
        ready: readiness.checks.sqliteReadWrite,
        migrationCurrent: readiness.checks.migrationCurrent,
      },
      storage: {
        physicalBytes: physical?.totalBytes ?? null,
        logicalPayloadBytes: snapshot.logicalPayloadBytes,
        oldestEventReceivedAt: snapshot.oldestEventReceivedAt,
        freeBytes: physical?.freeBytes ?? null,
        components:
          physical === null
            ? null
            : {
                databaseBytes: physical.databaseBytes,
                walBytes: physical.walBytes,
                shmBytes: physical.shmBytes,
                temporaryBytes: physical.temporaryBytes,
                dataDirectoryOtherBytes: physical.dataDirectoryOtherBytes,
              },
        budgetBytes: this.#config.physicalTotalBytes,
        logicalHighBytes: this.#config.logicalHighBytes,
        logicalTargetBytes: this.#config.logicalTargetBytes,
        physicalCriticalBytes: this.#config.physicalCriticalBytes,
        minimumFreeBytes: this.#config.minimumFreeBytes,
        safety: snapshot.safety,
      },
      retention: {
        knownSuccessful: snapshot.retentionKnownSuccessful,
        lastRun: snapshot.lastRun,
        lastFailure: snapshot.lastFailure,
        removedEvents: snapshot.removedEvents,
      },
      ingest: { accepting: snapshot.acceptingIngest },
      outbox: {
        pending: outbox.pending,
        retry: outbox.retry,
        delivered: outbox.delivered,
        deadLetter: outbox.dead_letter,
        suppressed: outbox.suppressed,
      },
      redrives: {
        pending: redrives.pending,
        delivered: redrives.delivered,
        deadLetter: redrives.dead_letter,
      },
    };
  }
}

function sqliteReadWrite(database: ErrorHubDatabase): boolean {
  if (database.inTransaction) return false;
  try {
    database.exec("BEGIN IMMEDIATE");
    const readable =
      (
        database.prepare("SELECT 1 AS ready").get() as {
          ready: number;
        }
      ).ready === 1;
    const writable =
      database
        .prepare(
          `UPDATE schema_migrations
           SET applied_at = applied_at
           WHERE version = ?`,
        )
        .run(CURRENT_MIGRATION_VERSION).changes === 1;
    database.exec("ROLLBACK");
    return readable && writable;
  } catch {
    if (database.inTransaction) {
      try {
        database.exec("ROLLBACK");
      } catch {
        return false;
      }
    }
    return false;
  }
}

function migrationCurrent(database: ErrorHubDatabase): boolean {
  try {
    const userVersion = database.pragma("user_version", {
      simple: true,
    });
    const latest = database
      .prepare("SELECT MAX(version) AS version FROM schema_migrations")
      .get() as { version: number | null };
    return (
      userVersion === CURRENT_MIGRATION_VERSION &&
      latest.version === CURRENT_MIGRATION_VERSION
    );
  } catch {
    return false;
  }
}

function stateCounts<const State extends string>(
  database: ErrorHubDatabase,
  table: "webhook_outbox" | "webhook_redrives",
  states: readonly State[],
): Record<State, number> {
  const counts = Object.fromEntries(
    states.map((state) => [state, 0]),
  ) as Record<State, number>;
  const rows = database
    .prepare(`SELECT state, COUNT(*) AS count FROM ${table} GROUP BY state`)
    .all() as { state: State; count: number }[];
  for (const row of rows) {
    if (states.includes(row.state)) counts[row.state] = row.count;
  }
  return counts;
}

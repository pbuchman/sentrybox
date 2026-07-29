import type { ErrorHubDatabase } from "../storage/database.js";
import type { OperationsContext } from "../operations.js";
import {
  type PhysicalStorageUsage,
  type RetentionConfig,
} from "./storage-budget.js";
import {
  readRetentionStorageAccounting,
  reconcileRetentionAccountingStep,
} from "./accounting.js";

export type RetentionRemovalReason = "age" | "budget";

export interface RetentionBatch {
  readonly reason: RetentionRemovalReason;
  readonly eventIds: readonly number[];
  readonly affectedIssueIds: readonly number[];
}

export interface WalCheckpointResult {
  readonly busy: number;
  readonly logFrames: number;
  readonly checkpointedFrames: number;
}

export interface RetentionRunResult {
  readonly success: boolean;
  readonly failure: "cleanup_failed" | "physical_storage_critical" | null;
  readonly removedEvents: {
    readonly age: number;
    readonly budget: number;
  };
  readonly removedOutbox: number;
  readonly removedRedrives: number;
  readonly batches: number;
  readonly checkpoint: WalCheckpointResult | null;
  readonly usage: {
    readonly physical: PhysicalStorageUsage | null;
    readonly logicalPayloadBytes: number;
    readonly oldestEventReceivedAt: string | null;
  };
}

export interface RetentionSweeperOptions {
  readonly database: ErrorHubDatabase;
  readonly operations: OperationsContext;
  readonly clock?: () => Date;
  readonly readPhysicalUsage: () =>
    | PhysicalStorageUsage
    | Promise<PhysicalStorageUsage>;
  readonly checkpoint?: () => WalCheckpointResult;
  readonly emergencyCheckpoint?: () => WalCheckpointResult;
  readonly incrementalVacuum?: (pages: number) => void;
  readonly yieldControl?: () => void | Promise<void>;
  readonly onBatch?: (batch: RetentionBatch) => void;
}

interface EventCandidate {
  readonly id: number;
  readonly issue_id: number;
  readonly compressed_payload_bytes: number;
}

export class RetentionSweeper {
  readonly #database: ErrorHubDatabase;
  readonly #clock: () => Date;
  readonly #config: RetentionConfig;
  readonly #operations: OperationsContext;
  readonly #readPhysicalUsage: RetentionSweeperOptions["readPhysicalUsage"];
  readonly #checkpoint: () => WalCheckpointResult;
  readonly #emergencyCheckpoint: () => WalCheckpointResult;
  readonly #incrementalVacuum: (pages: number) => void;
  readonly #yieldControl: () => void | Promise<void>;
  readonly #onBatch: ((batch: RetentionBatch) => void) | undefined;

  public constructor(options: RetentionSweeperOptions) {
    this.#database = options.database;
    this.#clock = options.clock ?? (() => new Date());
    this.#config = options.operations.retentionConfig;
    this.#operations = options.operations;
    this.#readPhysicalUsage = options.readPhysicalUsage;
    this.#checkpoint =
      options.checkpoint ?? (() => passiveCheckpoint(this.#database));
    this.#emergencyCheckpoint =
      options.emergencyCheckpoint ?? (() => restartCheckpoint(this.#database));
    this.#incrementalVacuum =
      options.incrementalVacuum ??
      ((pages) => {
        this.#database.pragma(`incremental_vacuum(${String(pages)})`);
      });
    this.#yieldControl = options.yieldControl ?? (() => undefined);
    this.#onBatch = options.onBatch;
  }

  public async run(): Promise<RetentionRunResult> {
    const now = validDate(this.#clock(), "retention clock");
    const removedEvents = { age: 0, budget: 0 };
    let removedOutbox = 0;
    let removedRedrives = 0;
    let batches = 0;
    let checkpoint: WalCheckpointResult | null = null;
    let physical: PhysicalStorageUsage | null = null;
    let logical = 0;
    let oldest: string | null = null;
    let stoppedAtHardLimit = false;
    try {
      reconcileRetentionAccountingStep(this.#database, this.#config.batchSize);
      ({ logicalPayloadBytes: logical, oldestEventReceivedAt: oldest } =
        readRetentionStorageAccounting(this.#database));
      physical = await this.sampleAndPublish(logical, oldest);
      if (this.isPhysicalCritical(physical)) {
        physical = await this.emergencyReclaimAndResample(logical, oldest);
      }
      stoppedAtHardLimit = this.isHardPhysicalLimit(physical);
      const ageCutoff = new Date(
        now.getTime() - this.#config.eventAgeMs,
      ).toISOString();
      let refreshAgeAccounting = false;
      while (!stoppedAtHardLimit) {
        if (refreshAgeAccounting) {
          ({ logicalPayloadBytes: logical, oldestEventReceivedAt: oldest } =
            readRetentionStorageAccounting(this.#database));
        }
        const candidates = this.selectAgeCandidates(ageCutoff);
        if (candidates.length === 0) break;
        this.deleteEventBatch(candidates, "age");
        removedEvents.age += candidates.length;
        batches += 1;
        ({ logical, oldest } = this.accountAfterEventBatch(
          logical,
          candidates,
        ));
        physical = await this.afterBatch(logical, oldest);
        stoppedAtHardLimit = this.isHardPhysicalLimit(physical);
        refreshAgeAccounting = true;
      }

      if (!stoppedAtHardLimit && logical > this.#config.logicalHighBytes) {
        while (
          !stoppedAtHardLimit &&
          logical > this.#config.logicalTargetBytes
        ) {
          const candidates = this.selectBudgetCandidates();
          if (candidates.length === 0) {
            throw new Error("logical payload usage cannot be reduced");
          }
          this.deleteEventBatch(candidates, "budget");
          removedEvents.budget += candidates.length;
          batches += 1;
          ({ logical, oldest } = this.accountAfterEventBatch(
            logical,
            candidates,
          ));
          physical = await this.afterBatch(logical, oldest);
          stoppedAtHardLimit = this.isHardPhysicalLimit(physical);
          if (!stoppedAtHardLimit) {
            ({ logicalPayloadBytes: logical, oldestEventReceivedAt: oldest } =
              readRetentionStorageAccounting(this.#database));
          }
        }
      }

      const deliveryCutoff = new Date(
        now.getTime() - this.#config.deliveryTtlMs,
      ).toISOString();
      if (!stoppedAtHardLimit) {
        const redriveCleanup = await this.cleanupTerminalRedrives(
          deliveryCutoff,
          logical,
          oldest,
        );
        removedRedrives += redriveCleanup.removed;
        batches += redriveCleanup.batches;
        physical = redriveCleanup.physical ?? physical;
        stoppedAtHardLimit = redriveCleanup.stoppedAtHardLimit;
      }
      if (!stoppedAtHardLimit) {
        const outboxCleanup = await this.cleanupDeliveredOutbox(
          deliveryCutoff,
          logical,
          oldest,
        );
        removedOutbox += outboxCleanup.removed;
        batches += outboxCleanup.batches;
        physical = outboxCleanup.physical ?? physical;
        stoppedAtHardLimit = outboxCleanup.stoppedAtHardLimit;
      }

      if (batches > 0) {
        checkpoint = this.#checkpoint();
        validateCheckpoint(checkpoint);
        this.#incrementalVacuum(this.#config.incrementalVacuumPages);
      }

      ({ logicalPayloadBytes: logical, oldestEventReceivedAt: oldest } =
        readRetentionStorageAccounting(this.#database));
      physical = await this.sampleAndPublish(logical, oldest);
      if (this.isPhysicalCritical(physical)) {
        physical = await this.emergencyReclaimAndResample(logical, oldest);
      }
      if (this.isPhysicalCritical(physical)) {
        this.#operations.storageSafety.markFailure(
          "physical_storage_critical",
          now,
        );
        this.#operations.metrics.recordRetention("failure", removedEvents);
        return result(
          false,
          "physical_storage_critical",
          removedEvents,
          removedOutbox,
          removedRedrives,
          batches,
          checkpoint,
          physical,
          logical,
          oldest,
        );
      }
      this.#operations.storageSafety.markSuccess(now, removedEvents);
      this.#operations.metrics.recordRetention("success", removedEvents);
      return result(
        true,
        null,
        removedEvents,
        removedOutbox,
        removedRedrives,
        batches,
        checkpoint,
        physical,
        logical,
        oldest,
      );
    } catch {
      ({ logicalPayloadBytes: logical, oldestEventReceivedAt: oldest } =
        readRetentionStorageAccountingSafely(this.#database));
      this.#operations.storageSafety.markFailure("cleanup_failed", now);
      this.#operations.metrics.recordRetention("failure", removedEvents);
      return result(
        false,
        "cleanup_failed",
        removedEvents,
        removedOutbox,
        removedRedrives,
        batches,
        checkpoint,
        physical,
        logical,
        oldest,
      );
    }
  }

  private selectAgeCandidates(cutoff: string): readonly EventCandidate[] {
    return this.#database
      .prepare(
        `SELECT id, issue_id, compressed_payload_bytes
         FROM events INDEXED BY idx_events_retention_received
         WHERE received_at < ?
         ORDER BY received_at, id
         LIMIT ?`,
      )
      .all(cutoff, this.#config.batchSize) as EventCandidate[];
  }

  private selectBudgetCandidates(): readonly EventCandidate[] {
    return this.#database
      .prepare(
        `SELECT id, issue_id, compressed_payload_bytes
         FROM events INDEXED BY idx_events_retention_received
         ORDER BY received_at, id
         LIMIT ?`,
      )
      .all(this.#config.batchSize) as EventCandidate[];
  }

  private deleteEventBatch(
    candidates: readonly EventCandidate[],
    reason: RetentionRemovalReason,
  ): void {
    const eventIds = candidates.map((candidate) => candidate.id);
    const issueIds = [
      ...new Set(candidates.map((candidate) => candidate.issue_id)),
    ];
    const eventPlaceholders = placeholders(eventIds);
    const issuePlaceholders = placeholders(issueIds);
    this.#database
      .transaction(() => {
        const deleted = this.#database
          .prepare(`DELETE FROM events WHERE id IN (${eventPlaceholders})`)
          .run(...eventIds);
        if (deleted.changes !== eventIds.length) {
          throw new Error("retention event batch changed during deletion");
        }
        this.#onBatch?.({ reason, eventIds, affectedIssueIds: issueIds });
        this.recomputeIssues(issueIds, issuePlaceholders);
      })
      .immediate();
  }

  private recomputeIssues(
    issueIds: readonly number[],
    issuePlaceholders: string,
  ): void {
    this.#database
      .prepare(
        `UPDATE issues
         SET occurrence_count = (
               SELECT COUNT(*) FROM events WHERE events.issue_id = issues.id
             ),
             first_seen = (
               SELECT MIN(occurred_at) FROM events WHERE events.issue_id = issues.id
             ),
             last_seen = (
               SELECT MAX(occurred_at) FROM events WHERE events.issue_id = issues.id
             ),
             last_received_at = (
               SELECT MAX(received_at) FROM events WHERE events.issue_id = issues.id
             ),
             highest_level = (
               SELECT CASE MAX(
                 CASE level WHEN 'fatal' THEN 2 WHEN 'error' THEN 1 ELSE 0 END
               )
                 WHEN 2 THEN 'fatal'
                 WHEN 1 THEN 'error'
                 ELSE 'warn'
               END
               FROM events WHERE events.issue_id = issues.id
             )
         WHERE id IN (${issuePlaceholders})
           AND EXISTS (SELECT 1 FROM events WHERE events.issue_id = issues.id)`,
      )
      .run(...issueIds);
    this.#database
      .prepare(
        `DELETE FROM issue_facets WHERE issue_id IN (${issuePlaceholders})`,
      )
      .run(...issueIds);
    for (const facet of [
      { type: "environment", column: "environment", nullable: false },
      { type: "release", column: "release", nullable: true },
      { type: "service", column: "service", nullable: true },
      { type: "level", column: "level", nullable: false },
    ] as const) {
      const value = facet.nullable
        ? `COALESCE(${facet.column}, '')`
        : facet.column;
      const isNull = facet.nullable
        ? `CASE WHEN ${facet.column} IS NULL THEN 1 ELSE 0 END`
        : "0";
      this.#database
        .prepare(
          `INSERT INTO issue_facets(
             issue_id, facet_type, facet_value, facet_value_is_null,
             occurrence_count, last_seen
           )
           SELECT issue_id, '${facet.type}', ${value}, ${isNull},
                  COUNT(*), MAX(occurred_at)
           FROM events
           WHERE issue_id IN (${issuePlaceholders})
           GROUP BY issue_id, ${facet.column}`,
        )
        .run(...issueIds);
    }
    this.#database
      .prepare(
        `DELETE FROM issues
         WHERE id IN (${issuePlaceholders})
           AND NOT EXISTS (SELECT 1 FROM events WHERE events.issue_id = issues.id)`,
      )
      .run(...issueIds);
  }

  private cleanupDeliveredOutbox(
    cutoff: string,
    logical: number,
    oldest: string | null,
  ): Promise<CleanupRowsResult> {
    return this.cleanupRows(
      `SELECT id
       FROM webhook_outbox INDEXED BY idx_outbox_retention_delivered
       WHERE state = 'delivered' AND delivered_at < ?
       ORDER BY delivered_at, id
       LIMIT ?`,
      "webhook_outbox",
      cutoff,
      logical,
      oldest,
    );
  }

  private cleanupTerminalRedrives(
    cutoff: string,
    logical: number,
    oldest: string | null,
  ): Promise<CleanupRowsResult> {
    return this.cleanupRows(
      `SELECT id
       FROM webhook_redrives INDEXED BY idx_webhook_redrives_retention_terminal
       WHERE state IN ('delivered', 'dead_letter') AND attempted_at < ?
       ORDER BY attempted_at, id
       LIMIT ?`,
      "webhook_redrives",
      cutoff,
      logical,
      oldest,
    );
  }

  private async cleanupRows(
    selectSql: string,
    table: "webhook_outbox" | "webhook_redrives",
    cutoff: string,
    logical: number,
    oldest: string | null,
  ): Promise<CleanupRowsResult> {
    let removed = 0;
    let batches = 0;
    let physical: PhysicalStorageUsage | null = null;
    for (;;) {
      const ids = (
        this.#database
          .prepare(selectSql)
          .all(cutoff, this.#config.batchSize) as { id: number }[]
      ).map((row) => row.id);
      if (ids.length === 0) {
        return { removed, batches, physical, stoppedAtHardLimit: false };
      }
      this.#database
        .transaction(() => {
          const deleted = this.#database
            .prepare(`DELETE FROM ${table} WHERE id IN (${placeholders(ids)})`)
            .run(...ids);
          if (deleted.changes !== ids.length) {
            throw new Error("retention cleanup batch changed during deletion");
          }
        })
        .immediate();
      removed += ids.length;
      batches += 1;
      physical = await this.afterBatch(logical, oldest);
      if (this.isHardPhysicalLimit(physical)) {
        return { removed, batches, physical, stoppedAtHardLimit: true };
      }
    }
  }

  private async afterBatch(
    logical: number,
    oldest: string | null,
  ): Promise<PhysicalStorageUsage> {
    let physical = await this.sampleAndPublish(logical, oldest);
    if (this.isPhysicalCritical(physical)) {
      physical = await this.emergencyReclaimAndResample(logical, oldest);
    }
    await this.#yieldControl();
    return physical;
  }

  private async sampleAndPublish(
    logical: number,
    oldest: string | null,
  ): Promise<PhysicalStorageUsage> {
    const physical = await this.#readPhysicalUsage();
    this.#operations.storageSafety.observeUsage(physical, logical, oldest);
    return physical;
  }

  private async emergencyReclaimAndResample(
    logical: number,
    oldest: string | null,
  ): Promise<PhysicalStorageUsage> {
    validateCheckpoint(this.#emergencyCheckpoint());
    this.#incrementalVacuum(this.#config.incrementalVacuumPages);
    return this.sampleAndPublish(logical, oldest);
  }

  private accountAfterEventBatch(
    previousLogical: number,
    candidates: readonly EventCandidate[],
  ): { readonly logical: number; readonly oldest: string | null } {
    const removedBytes = candidates.reduce(
      (total, candidate) =>
        safeIntegerSum(total, candidate.compressed_payload_bytes),
      0,
    );
    const logical = previousLogical - removedBytes;
    if (!Number.isSafeInteger(logical) || logical < 0) {
      throw new Error("retention event batch exceeded logical accounting");
    }
    const accounting = readRetentionStorageAccounting(this.#database);
    if (accounting.logicalPayloadBytes !== logical) {
      throw new Error("retention logical accounting changed unexpectedly");
    }
    return { logical, oldest: accounting.oldestEventReceivedAt };
  }

  private isPhysicalCritical(physical: PhysicalStorageUsage): boolean {
    return (
      physical.totalBytes >= this.#config.physicalCriticalBytes ||
      physical.freeBytes < this.#config.minimumFreeBytes
    );
  }

  private isHardPhysicalLimit(physical: PhysicalStorageUsage): boolean {
    return (
      physical.totalBytes >= this.#config.physicalTotalBytes ||
      physical.freeBytes < this.#config.minimumFreeBytes
    );
  }
}

interface CleanupRowsResult {
  readonly removed: number;
  readonly batches: number;
  readonly physical: PhysicalStorageUsage | null;
  readonly stoppedAtHardLimit: boolean;
}

function readRetentionStorageAccountingSafely(database: ErrorHubDatabase): {
  readonly logicalPayloadBytes: number;
  readonly oldestEventReceivedAt: string | null;
} {
  try {
    return readRetentionStorageAccounting(database);
  } catch {
    return { logicalPayloadBytes: 0, oldestEventReceivedAt: null };
  }
}

function safeIntegerSum(left: number, right: number): number {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new Error("retention batch byte count must be a safe integer");
  }
  return result;
}

function passiveCheckpoint(database: ErrorHubDatabase): WalCheckpointResult {
  const row = (
    database.pragma("wal_checkpoint(PASSIVE)") as {
      busy: number;
      log: number;
      checkpointed: number;
    }[]
  )[0];
  if (row === undefined)
    throw new Error("PASSIVE checkpoint returned no result");
  return {
    busy: row.busy,
    logFrames: row.log,
    checkpointedFrames: row.checkpointed,
  };
}

function restartCheckpoint(database: ErrorHubDatabase): WalCheckpointResult {
  const row = (
    database.pragma("wal_checkpoint(RESTART)") as {
      busy: number;
      log: number;
      checkpointed: number;
    }[]
  )[0];
  if (row === undefined)
    throw new Error("RESTART checkpoint returned no result");
  return {
    busy: row.busy,
    logFrames: row.log,
    checkpointedFrames: row.checkpointed,
  };
}

function validateCheckpoint(value: WalCheckpointResult): void {
  if (!Number.isSafeInteger(value.busy) || value.busy < 0) {
    throw new Error("WAL checkpoint returned invalid busy count");
  }
  for (const count of [value.logFrames, value.checkpointedFrames]) {
    if (!Number.isSafeInteger(count) || count < -1) {
      throw new Error("WAL checkpoint returned invalid frame counts");
    }
  }
}

function placeholders(values: readonly number[]): string {
  if (values.length === 0) throw new Error("retention batch must not be empty");
  return values.map(() => "?").join(",");
}

function validDate(value: Date, field: string): Date {
  if (!Number.isFinite(value.getTime())) {
    throw new TypeError(`${field} timestamp must be valid`);
  }
  return new Date(value.getTime());
}

function result(
  success: boolean,
  failure: RetentionRunResult["failure"],
  removedEvents: RetentionRunResult["removedEvents"],
  removedOutbox: number,
  removedRedrives: number,
  batches: number,
  checkpoint: WalCheckpointResult | null,
  physical: PhysicalStorageUsage | null,
  logicalPayloadBytesValue: number,
  oldestEventReceivedAtValue: string | null,
): RetentionRunResult {
  return {
    success,
    failure,
    removedEvents: { ...removedEvents },
    removedOutbox,
    removedRedrives,
    batches,
    checkpoint,
    usage: {
      physical,
      logicalPayloadBytes: logicalPayloadBytesValue,
      oldestEventReceivedAt: oldestEventReceivedAtValue,
    },
  };
}

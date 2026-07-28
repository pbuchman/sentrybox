import type { ErrorHubDatabase } from "../storage/database.js";
import type { ErrorHubMetrics } from "../metrics.js";
import {
  DEFAULT_RETENTION_CONFIG,
  StorageSafetyState,
  type PhysicalStorageUsage,
  type RetentionConfig,
  validateRetentionConfig,
} from "./storage-budget.js";

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
  readonly clock?: () => Date;
  readonly config?: Partial<RetentionConfig>;
  readonly safetyState: StorageSafetyState;
  readonly readPhysicalUsage: () =>
    | PhysicalStorageUsage
    | Promise<PhysicalStorageUsage>;
  readonly checkpoint?: () => WalCheckpointResult;
  readonly incrementalVacuum?: (pages: number) => void;
  readonly yieldControl?: () => void | Promise<void>;
  readonly onBatch?: (batch: RetentionBatch) => void;
  readonly metrics?: Pick<ErrorHubMetrics, "recordRetention">;
}

interface EventCandidate {
  readonly id: number;
  readonly issue_id: number;
}

export class RetentionSweeper {
  readonly #database: ErrorHubDatabase;
  readonly #clock: () => Date;
  readonly #config: RetentionConfig;
  readonly #safetyState: StorageSafetyState;
  readonly #readPhysicalUsage: RetentionSweeperOptions["readPhysicalUsage"];
  readonly #checkpoint: () => WalCheckpointResult;
  readonly #incrementalVacuum: (pages: number) => void;
  readonly #yieldControl: () => void | Promise<void>;
  readonly #onBatch: ((batch: RetentionBatch) => void) | undefined;
  readonly #metrics: Pick<ErrorHubMetrics, "recordRetention"> | undefined;

  public constructor(options: RetentionSweeperOptions) {
    this.#database = options.database;
    this.#clock = options.clock ?? (() => new Date());
    this.#config = validateRetentionConfig({
      ...DEFAULT_RETENTION_CONFIG,
      ...options.config,
    });
    this.#safetyState = options.safetyState;
    this.#readPhysicalUsage = options.readPhysicalUsage;
    this.#checkpoint =
      options.checkpoint ?? (() => passiveCheckpoint(this.#database));
    this.#incrementalVacuum =
      options.incrementalVacuum ??
      ((pages) => {
        this.#database.pragma(`incremental_vacuum(${String(pages)})`);
      });
    this.#yieldControl = options.yieldControl ?? (() => undefined);
    this.#onBatch = options.onBatch;
    this.#metrics = options.metrics;
  }

  public async run(): Promise<RetentionRunResult> {
    const now = validDate(this.#clock(), "retention clock");
    const removedEvents = { age: 0, budget: 0 };
    let removedOutbox = 0;
    let removedRedrives = 0;
    let batches = 0;
    let checkpoint: WalCheckpointResult | null = null;
    let physical: PhysicalStorageUsage | null = null;
    let logical = logicalPayloadBytes(this.#database);
    let oldest = oldestEventReceivedAt(this.#database);
    try {
      physical = await this.#readPhysicalUsage();
      this.#safetyState.observeUsage(physical, logical, oldest);
      const ageCutoff = new Date(
        now.getTime() - this.#config.eventAgeMs,
      ).toISOString();
      for (;;) {
        const candidates = this.selectAgeCandidates(ageCutoff);
        if (candidates.length === 0) break;
        this.deleteEventBatch(candidates, "age");
        removedEvents.age += candidates.length;
        batches += 1;
        await this.afterBatch();
      }

      logical = logicalPayloadBytes(this.#database);
      if (logical > this.#config.logicalHighBytes) {
        while (logical > this.#config.logicalTargetBytes) {
          const candidates = this.selectBudgetCandidates();
          if (candidates.length === 0) {
            throw new Error("logical payload usage cannot be reduced");
          }
          this.deleteEventBatch(candidates, "budget");
          removedEvents.budget += candidates.length;
          batches += 1;
          await this.afterBatch();
          logical = logicalPayloadBytes(this.#database);
        }
      }

      const deliveryCutoff = new Date(
        now.getTime() - this.#config.deliveryTtlMs,
      ).toISOString();
      const redriveCleanup = this.cleanupTerminalRedrives(deliveryCutoff);
      removedRedrives += redriveCleanup.removed;
      batches += redriveCleanup.batches;
      const outboxCleanup = this.cleanupDeliveredOutbox(deliveryCutoff);
      removedOutbox += outboxCleanup.removed;
      batches += outboxCleanup.batches;

      if (batches > 0) {
        checkpoint = this.#checkpoint();
        validateCheckpoint(checkpoint);
        this.#incrementalVacuum(this.#config.incrementalVacuumPages);
      }

      physical = await this.#readPhysicalUsage();
      logical = logicalPayloadBytes(this.#database);
      oldest = oldestEventReceivedAt(this.#database);
      this.#safetyState.observeUsage(physical, logical, oldest);
      if (
        physical.totalBytes >= this.#config.physicalCriticalBytes ||
        physical.freeBytes < this.#config.minimumFreeBytes
      ) {
        this.#safetyState.markFailure("physical_storage_critical", now);
        this.#metrics?.recordRetention("failure", removedEvents);
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
      this.#safetyState.markSuccess(now, removedEvents);
      this.#metrics?.recordRetention("success", removedEvents);
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
      logical = logicalPayloadBytesSafely(this.#database);
      oldest = oldestEventReceivedAtSafely(this.#database);
      this.#safetyState.markFailure("cleanup_failed", now);
      this.#metrics?.recordRetention("failure", removedEvents);
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
        `SELECT id, issue_id
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
        `SELECT id, issue_id
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

  private cleanupDeliveredOutbox(cutoff: string): {
    readonly removed: number;
    readonly batches: number;
  } {
    return this.cleanupRows(
      `SELECT id
       FROM webhook_outbox INDEXED BY idx_outbox_retention_delivered
       WHERE state = 'delivered' AND delivered_at < ?
       ORDER BY delivered_at, id
       LIMIT ?`,
      "webhook_outbox",
      cutoff,
    );
  }

  private cleanupTerminalRedrives(cutoff: string): {
    readonly removed: number;
    readonly batches: number;
  } {
    return this.cleanupRows(
      `SELECT id
       FROM webhook_redrives INDEXED BY idx_webhook_redrives_retention_terminal
       WHERE state IN ('delivered', 'dead_letter') AND attempted_at < ?
       ORDER BY attempted_at, id
       LIMIT ?`,
      "webhook_redrives",
      cutoff,
    );
  }

  private cleanupRows(
    selectSql: string,
    table: "webhook_outbox" | "webhook_redrives",
    cutoff: string,
  ): { readonly removed: number; readonly batches: number } {
    let removed = 0;
    let batches = 0;
    for (;;) {
      const ids = (
        this.#database
          .prepare(selectSql)
          .all(cutoff, this.#config.batchSize) as { id: number }[]
      ).map((row) => row.id);
      if (ids.length === 0) return { removed, batches };
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
    }
  }

  private async afterBatch(): Promise<void> {
    await this.#yieldControl();
    const physical = await this.#readPhysicalUsage();
    this.#safetyState.observeUsage(
      physical,
      logicalPayloadBytes(this.#database),
      oldestEventReceivedAt(this.#database),
    );
  }
}

function logicalPayloadBytes(database: ErrorHubDatabase): number {
  return (
    database
      .prepare(
        "SELECT COALESCE(SUM(compressed_payload_bytes), 0) AS bytes FROM events",
      )
      .get() as { bytes: number }
  ).bytes;
}

function oldestEventReceivedAt(database: ErrorHubDatabase): string | null {
  return (
    database.prepare("SELECT MIN(received_at) AS oldest FROM events").get() as {
      oldest: string | null;
    }
  ).oldest;
}

function logicalPayloadBytesSafely(database: ErrorHubDatabase): number {
  try {
    return logicalPayloadBytes(database);
  } catch {
    return 0;
  }
}

function oldestEventReceivedAtSafely(
  database: ErrorHubDatabase,
): string | null {
  try {
    return oldestEventReceivedAt(database);
  } catch {
    return null;
  }
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

function validateCheckpoint(value: WalCheckpointResult): void {
  if (!Number.isSafeInteger(value.busy) || value.busy < 0) {
    throw new Error("PASSIVE checkpoint returned invalid busy count");
  }
  for (const count of [value.logFrames, value.checkpointedFrames]) {
    if (!Number.isSafeInteger(count) || count < -1) {
      throw new Error("PASSIVE checkpoint returned invalid frame counts");
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

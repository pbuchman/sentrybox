import type { ErrorHubDatabase } from "../storage/database.js";

export interface RetentionStorageAccountingSnapshot {
  readonly logicalPayloadBytes: number;
  readonly oldestEventReceivedAt: string | null;
}

export interface RetentionAccountingReconciliation {
  readonly complete: boolean;
  readonly scannedEvents: number;
}

interface AccountingRow {
  readonly logical_payload_bytes: number;
  readonly mutation_revision: number;
  readonly reconciliation_revision: number;
  readonly reconciliation_max_event_id: number;
  readonly reconciliation_cursor_id: number;
  readonly reconciliation_payload_bytes: number;
}

interface ReconciliationEventRow {
  readonly id: number;
  readonly compressed_payload_bytes: number;
}

export function readRetentionStorageAccounting(
  database: ErrorHubDatabase,
): RetentionStorageAccountingSnapshot {
  const accounting = readAccountingRow(database);
  const oldest = database
    .prepare(
      `SELECT received_at
       FROM events INDEXED BY idx_events_retention_received
       ORDER BY received_at, id
       LIMIT 1`,
    )
    .get() as { received_at: string } | undefined;
  return {
    logicalPayloadBytes: safeNonNegativeInteger(
      accounting.logical_payload_bytes,
      "retention logical payload bytes",
    ),
    oldestEventReceivedAt: oldest?.received_at ?? null,
  };
}

export function reconcileRetentionAccountingStep(
  database: ErrorHubDatabase,
  batchSize: number,
): RetentionAccountingReconciliation {
  if (!Number.isSafeInteger(batchSize) || batchSize <= 0) {
    throw new TypeError(
      "retention reconciliation batch size must be a positive safe integer",
    );
  }
  return database
    .transaction(() => {
      let accounting = readAccountingRow(database);
      let revision = safeNonNegativeInteger(
        accounting.mutation_revision,
        "retention accounting mutation revision",
      );
      let maxEventId = safeNonNegativeInteger(
        accounting.reconciliation_max_event_id,
        "retention reconciliation max event id",
      );
      let cursor = accounting.reconciliation_cursor_id;
      let payloadBytes = safeNonNegativeInteger(
        accounting.reconciliation_payload_bytes,
        "retention reconciliation payload bytes",
      );
      if (accounting.reconciliation_revision !== revision || cursor === -1) {
        const newest = database
          .prepare("SELECT id FROM events ORDER BY id DESC LIMIT 1")
          .get() as { id: number } | undefined;
        maxEventId = newest?.id ?? 0;
        cursor = 0;
        payloadBytes = 0;
        database
          .prepare(
            `UPDATE retention_accounting
             SET reconciliation_revision = ?,
                 reconciliation_max_event_id = ?,
                 reconciliation_cursor_id = 0,
                 reconciliation_payload_bytes = 0
             WHERE singleton = 1`,
          )
          .run(revision, maxEventId);
        accounting = readAccountingRow(database);
        revision = accounting.mutation_revision;
      }
      const rows = database
        .prepare(
          `SELECT id, compressed_payload_bytes
           FROM events
           WHERE id > ? AND id <= ?
           ORDER BY id
           LIMIT ?`,
        )
        .all(cursor, maxEventId, batchSize) as ReconciliationEventRow[];
      for (const row of rows) {
        payloadBytes = safeSum(
          payloadBytes,
          row.compressed_payload_bytes,
          "retention reconciliation payload bytes",
        );
      }
      const lastId = rows.at(-1)?.id ?? cursor;
      const complete = rows.length === 0 || lastId === maxEventId;
      if (complete) {
        if (payloadBytes !== accounting.logical_payload_bytes) {
          throw new Error("retention logical accounting drift detected");
        }
        database
          .prepare(
            `UPDATE retention_accounting
             SET reconciliation_cursor_id = -1,
                 reconciliation_payload_bytes = 0
             WHERE singleton = 1 AND mutation_revision = ?`,
          )
          .run(revision);
      } else {
        database
          .prepare(
            `UPDATE retention_accounting
             SET reconciliation_cursor_id = ?,
                 reconciliation_payload_bytes = ?
             WHERE singleton = 1 AND mutation_revision = ?`,
          )
          .run(lastId, payloadBytes, revision);
      }
      return { complete, scannedEvents: rows.length };
    })
    .immediate();
}

function readAccountingRow(database: ErrorHubDatabase): AccountingRow {
  const row = database
    .prepare(
      `SELECT logical_payload_bytes, mutation_revision,
              reconciliation_revision, reconciliation_max_event_id,
              reconciliation_cursor_id, reconciliation_payload_bytes
       FROM retention_accounting
       WHERE singleton = 1`,
    )
    .get() as AccountingRow | undefined;
  if (row === undefined) {
    throw new Error("retention accounting singleton is unavailable");
  }
  return row;
}

function safeSum(left: number, right: number, field: string): number {
  return safeNonNegativeInteger(left + right, field);
}

function safeNonNegativeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative safe integer`);
  }
  return value;
}

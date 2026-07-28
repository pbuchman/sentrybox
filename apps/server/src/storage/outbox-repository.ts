import type { ErrorHubDatabase } from "./database.js";

export interface OutboxTransition {
  readonly issueId: number;
  readonly projectId: number;
  readonly eventId: string;
  readonly generation: number;
  readonly cause: "created" | "regressed";
}

interface CommonOutboxDraft {
  readonly deliveryId: string;
  readonly body: Buffer;
}

export type OutboxDraft =
  | (CommonOutboxDraft & {
      readonly mode: "disabled";
      readonly targetUrl: null;
      readonly secretRef: null;
    })
  | (CommonOutboxDraft & {
      readonly mode: "live";
      readonly targetUrl: string;
      readonly secretRef: string;
    });

export interface StoredOutboxRow {
  readonly id: number;
  readonly deliveryId: string;
  readonly projectId: number;
  readonly issueId: number;
  readonly eventId: string;
  readonly generation: number;
  readonly cause: "created" | "regressed";
  readonly destinationMode: "disabled" | "live";
  readonly targetUrl: string | null;
  readonly secretRef: string | null;
  readonly body: Buffer;
  readonly state:
    | "pending"
    | "retry"
    | "delivered"
    | "dead_letter"
    | "suppressed";
  readonly attempts: number;
  readonly nextAttempt: string | null;
  readonly lastError: string | null;
  readonly dispatchLeaseId: string | null;
  readonly dispatchLeaseUntil: string | null;
  readonly createdAt: string;
  readonly deliveredAt: string | null;
}

interface OutboxRow {
  id: number;
  delivery_id: string;
  project_id: number;
  issue_id: number;
  event_id: string;
  generation: number;
  cause: StoredOutboxRow["cause"];
  destination_mode: StoredOutboxRow["destinationMode"];
  target_url: string | null;
  secret_ref: string | null;
  body: Buffer;
  state: StoredOutboxRow["state"];
  attempts: number;
  next_attempt: string | null;
  last_error: string | null;
  dispatch_lease_id: string | null;
  dispatch_lease_until: string | null;
  created_at: string;
  delivered_at: string | null;
}

const OUTBOX_COLUMNS = `
  id, delivery_id, project_id, issue_id, event_id, generation, cause,
  destination_mode, target_url, secret_ref, body, state, attempts,
  next_attempt, last_error, dispatch_lease_id, dispatch_lease_until,
  created_at, delivered_at
`;

export class OutboxRepository {
  public constructor(private readonly database: ErrorHubDatabase) {}

  public insert(
    transition: OutboxTransition,
    draft: OutboxDraft,
    createdAt: string,
  ): number {
    if (draft.body.byteLength === 0) {
      throw new TypeError("outbox body must not be empty");
    }
    const pending = draft.mode === "live";
    const result = this.database
      .prepare(
        `INSERT INTO webhook_outbox (
           delivery_id, project_id, issue_id, event_id, generation, cause,
           destination_mode, target_url, secret_ref, body, state, attempts,
           next_attempt, last_error, dispatch_lease_id, dispatch_lease_until,
           created_at, delivered_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, NULL, NULL, NULL, ?, NULL)`,
      )
      .run(
        draft.deliveryId,
        transition.projectId,
        transition.issueId,
        transition.eventId,
        transition.generation,
        transition.cause,
        draft.mode,
        draft.targetUrl,
        draft.secretRef,
        draft.body,
        pending ? "pending" : "suppressed",
        pending ? createdAt : null,
        createdAt,
      );
    return safeInteger(result.lastInsertRowid, "outbox row id");
  }

  public getById(id: number): StoredOutboxRow | null {
    const row = this.database
      .prepare(`SELECT ${OUTBOX_COLUMNS} FROM webhook_outbox WHERE id = ?`)
      .get(id) as OutboxRow | undefined;
    return row === undefined ? null : mapRow(row);
  }

  public listByIssue(issueId: number): readonly StoredOutboxRow[] {
    const rows = this.database
      .prepare(
        `SELECT ${OUTBOX_COLUMNS}
         FROM webhook_outbox
         WHERE issue_id = ?
         ORDER BY generation, id`,
      )
      .all(issueId) as OutboxRow[];
    return rows.map(mapRow);
  }

  /**
   * Atomically leases due work. A crashed process leaves the row retryable as
   * soon as the bounded lease expires, while concurrent dispatcher ticks cannot
   * observe the same row.
   */
  public claimDue(
    claimedAt: string,
    leaseUntil: string,
    leaseId: string,
    limit: number,
  ): readonly StoredOutboxRow[] {
    const canonicalClaimedAt = timestamp(claimedAt, "claim timestamp");
    const canonicalLeaseUntil = timestamp(leaseUntil, "lease timestamp");
    if (canonicalLeaseUntil <= canonicalClaimedAt) {
      throw new TypeError("lease timestamp must be after claim timestamp");
    }
    nonEmpty(leaseId, "lease id");
    positiveInteger(limit, "claim limit");
    return this.database
      .transaction(() => {
        const candidates = this.database
          .prepare(
            `SELECT id
             FROM webhook_outbox
             WHERE state IN ('pending', 'retry')
               AND next_attempt <= ?
               AND (dispatch_lease_until IS NULL OR dispatch_lease_until <= ?)
             ORDER BY next_attempt, id
             LIMIT ?`,
          )
          .all(canonicalClaimedAt, canonicalClaimedAt, limit) as {
          id: number;
        }[];
        if (candidates.length === 0) return [];
        const claim = this.database.prepare(
          `UPDATE webhook_outbox
           SET dispatch_lease_id = ?, dispatch_lease_until = ?
           WHERE id = ? AND state IN ('pending', 'retry')
             AND next_attempt <= ?
             AND (dispatch_lease_until IS NULL OR dispatch_lease_until <= ?)`,
        );
        const claimed: StoredOutboxRow[] = [];
        for (const candidate of candidates) {
          const result = claim.run(
            leaseId,
            canonicalLeaseUntil,
            candidate.id,
            canonicalClaimedAt,
            canonicalClaimedAt,
          );
          if (result.changes !== 1) continue;
          const row = this.getById(candidate.id);
          if (row !== null) claimed.push(row);
        }
        return claimed;
      })
      .immediate();
  }

  public markDelivered(id: number, deliveredAt: string): void {
    const result = this.database
      .prepare(
        `UPDATE webhook_outbox
         SET state = 'delivered', attempts = attempts + 1,
             next_attempt = NULL, last_error = NULL, delivered_at = ?
         WHERE id = ? AND state IN ('pending', 'retry')
           AND dispatch_lease_id IS NULL`,
      )
      .run(deliveredAt, id);
    if (result.changes !== 1) {
      throw new Error("outbox delivery is not pending or retryable");
    }
  }

  public completeDelivered(
    id: number,
    leaseId: string,
    deliveredAt: string,
  ): boolean {
    const result = this.database
      .prepare(
        `UPDATE webhook_outbox
         SET state = 'delivered', attempts = attempts + 1,
             next_attempt = NULL, last_error = NULL, delivered_at = ?,
             dispatch_lease_id = NULL, dispatch_lease_until = NULL
         WHERE id = ? AND state IN ('pending', 'retry')
           AND dispatch_lease_id = ?`,
      )
      .run(timestamp(deliveredAt, "delivery timestamp"), id, leaseId);
    return result.changes === 1;
  }

  public completeRetry(
    id: number,
    leaseId: string,
    nextAttempt: string,
    error: string,
  ): boolean {
    const result = this.database
      .prepare(
        `UPDATE webhook_outbox
         SET state = 'retry', attempts = attempts + 1,
             next_attempt = ?, last_error = ?, delivered_at = NULL,
             dispatch_lease_id = NULL, dispatch_lease_until = NULL
         WHERE id = ? AND state IN ('pending', 'retry')
           AND dispatch_lease_id = ?`,
      )
      .run(
        timestamp(nextAttempt, "next attempt timestamp"),
        boundedError(error),
        id,
        leaseId,
      );
    return result.changes === 1;
  }

  public completeDeadLetter(
    id: number,
    leaseId: string,
    error: string,
  ): boolean {
    const result = this.database
      .prepare(
        `UPDATE webhook_outbox
         SET state = 'dead_letter', attempts = attempts + 1,
             next_attempt = NULL, last_error = ?, delivered_at = NULL,
             dispatch_lease_id = NULL, dispatch_lease_until = NULL
         WHERE id = ? AND state IN ('pending', 'retry')
           AND dispatch_lease_id = ?`,
      )
      .run(boundedError(error), id, leaseId);
    return result.changes === 1;
  }

  public retryDeadLetter(id: number, retryAt: string): boolean {
    const result = this.database
      .prepare(
        `UPDATE webhook_outbox
         SET state = 'retry', next_attempt = ?, last_error = NULL,
             dispatch_lease_id = NULL, dispatch_lease_until = NULL
         WHERE id = ? AND state = 'dead_letter' AND destination_mode = 'live'`,
      )
      .run(timestamp(retryAt, "manual retry timestamp"), id);
    return result.changes === 1;
  }
}

function mapRow(row: OutboxRow): StoredOutboxRow {
  return {
    id: row.id,
    deliveryId: row.delivery_id,
    projectId: row.project_id,
    issueId: row.issue_id,
    eventId: row.event_id,
    generation: row.generation,
    cause: row.cause,
    destinationMode: row.destination_mode,
    targetUrl: row.target_url,
    secretRef: row.secret_ref,
    body: row.body,
    state: row.state,
    attempts: row.attempts,
    nextAttempt: row.next_attempt,
    lastError: row.last_error,
    dispatchLeaseId: row.dispatch_lease_id,
    dispatchLeaseUntil: row.dispatch_lease_until,
    createdAt: row.created_at,
    deliveredAt: row.delivered_at,
  };
}

function timestamp(value: string, field: string): string {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw new TypeError(`${field} must be an ISO timestamp`);
  }
  return new Date(milliseconds).toISOString();
}

function nonEmpty(value: string, field: string): string {
  if (value.length === 0) throw new TypeError(`${field} must not be empty`);
  return value;
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${field} must be a positive safe integer`);
  }
  return value;
}

function boundedError(error: string): string {
  const value = nonEmpty(error, "delivery error");
  return value.length <= 256 ? value : value.slice(0, 256);
}

function safeInteger(value: number | bigint, field: string): number {
  const converted = typeof value === "bigint" ? Number(value) : value;
  if (!Number.isSafeInteger(converted) || converted <= 0) {
    throw new RangeError(`${field} must be a positive safe integer`);
  }
  return converted;
}

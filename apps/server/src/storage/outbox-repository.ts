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
  created_at: string;
  delivered_at: string | null;
}

const OUTBOX_COLUMNS = `
  id, delivery_id, project_id, issue_id, event_id, generation, cause,
  destination_mode, target_url, secret_ref, body, state, attempts,
  next_attempt, last_error, created_at, delivered_at
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
           next_attempt, last_error, created_at, delivered_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, NULL, ?, NULL)`,
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

  public markDelivered(id: number, deliveredAt: string): void {
    const result = this.database
      .prepare(
        `UPDATE webhook_outbox
         SET state = 'delivered', attempts = attempts + 1,
             next_attempt = NULL, last_error = NULL, delivered_at = ?
         WHERE id = ? AND state IN ('pending', 'retry')`,
      )
      .run(deliveredAt, id);
    if (result.changes !== 1) {
      throw new Error("outbox delivery is not pending or retryable");
    }
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
    createdAt: row.created_at,
    deliveredAt: row.delivered_at,
  };
}

function safeInteger(value: number | bigint, field: string): number {
  const converted = typeof value === "bigint" ? Number(value) : value;
  if (!Number.isSafeInteger(converted) || converted <= 0) {
    throw new RangeError(`${field} must be a positive safe integer`);
  }
  return converted;
}

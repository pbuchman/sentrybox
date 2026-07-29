import type { ErrorHubDatabase } from "./database.js";
import type { SecretStore } from "../secrets.js";
import { validateWebhookDestination } from "../webhooks/destination.js";
import { signWebhookBody } from "../webhooks/signature.js";

export interface OutboxTransition {
  readonly issueId: number;
  readonly projectId: number;
  readonly eventId: string;
  readonly generation: number;
  readonly cause: "created" | "regressed";
  readonly environment: string;
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
      readonly signature: null;
    })
  | (CommonOutboxDraft & {
      readonly mode: "live";
      readonly targetUrl: string;
      readonly secretRef: string;
      readonly signature: string;
    });

export interface StoredOutboxRow {
  readonly id: number;
  readonly deliveryId: string;
  readonly projectId: number;
  readonly issueId: number;
  readonly eventId: string;
  readonly generation: number;
  readonly cause: "created" | "regressed";
  readonly environment: string | null;
  readonly destinationMode: "disabled" | "live";
  readonly targetUrl: string | null;
  readonly secretRef: string | null;
  readonly body: Buffer;
  readonly signature: string | null;
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

export interface StoredWebhookRedrive {
  readonly id: number;
  readonly deliveryId: string;
  readonly originalOutboxId: number;
  readonly targetUrl: string;
  readonly secretRef: string;
  readonly signature: string;
  readonly state: "pending" | "delivered" | "dead_letter";
  readonly attempts: 0 | 1;
  readonly dispatchLeaseId: string | null;
  readonly dispatchLeaseUntil: string | null;
  readonly requestedAt: string;
  readonly attemptedAt: string | null;
  readonly lastError: string | null;
}

export interface ClaimedWebhookRedrive extends StoredWebhookRedrive {
  readonly body: Buffer;
}

export class WebhookRedriveNotFoundError extends Error {
  public constructor() {
    super("webhook delivery not found");
    this.name = "WebhookRedriveNotFoundError";
  }
}

export class WebhookRedriveConflictError extends Error {
  public constructor() {
    super("webhook delivery cannot be redriven");
    this.name = "WebhookRedriveConflictError";
  }
}

export interface DueFrontierCursor {
  readonly nextAttempt: string;
  readonly id: number;
}

export interface PreparedDueFrontier {
  readonly inspected: number;
  readonly terminalized: number;
  readonly claimableIds: readonly number[];
  readonly cursor: DueFrontierCursor | null;
}

interface OutboxRow {
  id: number;
  delivery_id: string;
  project_id: number;
  issue_id: number;
  event_id: string;
  generation: number;
  cause: StoredOutboxRow["cause"];
  environment: string | null;
  destination_mode: StoredOutboxRow["destinationMode"];
  target_url: string | null;
  secret_ref: string | null;
  body: Buffer;
  signature: string | null;
  state: StoredOutboxRow["state"];
  attempts: number;
  next_attempt: string | null;
  last_error: string | null;
  dispatch_lease_id: string | null;
  dispatch_lease_until: string | null;
  created_at: string;
  delivered_at: string | null;
}

interface RedriveRow {
  id: number;
  delivery_id: string;
  original_outbox_id: number;
  target_url: string;
  secret_ref: string;
  signature: string;
  state: StoredWebhookRedrive["state"];
  attempts: 0 | 1;
  dispatch_lease_id: string | null;
  dispatch_lease_until: string | null;
  requested_at: string;
  attempted_at: string | null;
  last_error: string | null;
  body?: Buffer;
}

const OUTBOX_COLUMNS = `
  id, delivery_id, project_id, issue_id, event_id, generation, cause, environment,
  destination_mode, target_url, secret_ref, body, signature, state, attempts,
  next_attempt, last_error, dispatch_lease_id, dispatch_lease_until,
  created_at, delivered_at
`;

const REDRIVE_COLUMNS = `
  id, delivery_id, original_outbox_id, target_url, secret_ref, signature,
  state, attempts, dispatch_lease_id, dispatch_lease_until, requested_at,
  attempted_at, last_error
`;

const REDRIVE_JOIN_COLUMNS = `
  r.id, r.delivery_id, r.original_outbox_id, r.target_url, r.secret_ref,
  r.signature, r.state, r.attempts, r.dispatch_lease_id,
  r.dispatch_lease_until, r.requested_at, r.attempted_at, r.last_error
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
    if (
      (draft.mode === "live" && !isSignature(draft.signature)) ||
      (draft.mode === "disabled" && draft.signature !== null)
    ) {
      throw new TypeError("outbox signature does not match destination mode");
    }
    const pending = draft.mode === "live";
    const result = this.database
      .prepare(
        `INSERT INTO webhook_outbox (
           delivery_id, project_id, issue_id, event_id, generation, cause, environment,
           destination_mode, target_url, secret_ref, body, signature, state, attempts,
           next_attempt, last_error, dispatch_lease_id, dispatch_lease_until,
           created_at, delivered_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, NULL, NULL, NULL, ?, NULL)`,
      )
      .run(
        draft.deliveryId,
        transition.projectId,
        transition.issueId,
        transition.eventId,
        transition.generation,
        transition.cause,
        transition.environment,
        draft.mode,
        draft.targetUrl,
        draft.secretRef,
        draft.body,
        draft.signature,
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

  public prepareDue(
    checkedAt: string,
    limit: number,
    after: DueFrontierCursor | null = null,
  ): PreparedDueFrontier {
    const canonicalCheckedAt = timestamp(checkedAt, "due check timestamp");
    positiveInteger(limit, "due frontier limit");
    const canonicalAfter =
      after === null
        ? null
        : {
            nextAttempt: timestamp(
              after.nextAttempt,
              "due frontier cursor timestamp",
            ),
            id: positiveInteger(after.id, "due frontier cursor id"),
          };
    return this.database
      .transaction(() => {
        const cutoff = new Date(
          Date.parse(canonicalCheckedAt) - 7 * 24 * 60 * 60_000,
        ).toISOString();
        const candidates = (
          canonicalAfter === null
            ? this.database
                .prepare(
                  `SELECT id, next_attempt, created_at, attempts,
                        dispatch_lease_until
                 FROM webhook_outbox INDEXED BY idx_webhook_outbox_due_frontier
                 WHERE state IN ('pending', 'retry') AND next_attempt <= ?
                 ORDER BY next_attempt, id
                 LIMIT ?`,
                )
                .all(canonicalCheckedAt, limit)
            : this.database
                .prepare(
                  `SELECT id, next_attempt, created_at, attempts,
                        dispatch_lease_until
                 FROM webhook_outbox INDEXED BY idx_webhook_outbox_due_frontier
                 WHERE state IN ('pending', 'retry') AND next_attempt <= ?
                   AND (next_attempt, id) > (?, ?)
                 ORDER BY next_attempt, id
                 LIMIT ?`,
                )
                .all(
                  canonicalCheckedAt,
                  canonicalAfter.nextAttempt,
                  canonicalAfter.id,
                  limit,
                )
        ) as {
          id: number;
          next_attempt: string;
          created_at: string;
          attempts: number;
          dispatch_lease_until: string | null;
        }[];
        const terminalize = this.database.prepare(
          `UPDATE webhook_outbox
           SET state = 'dead_letter', next_attempt = NULL, last_error = ?,
               dispatch_lease_id = NULL, dispatch_lease_until = NULL
           WHERE id = ? AND state IN ('pending', 'retry')
             AND next_attempt <= ?
             AND (created_at < ? OR attempts >= 9007199254740991)
             AND (dispatch_lease_until IS NULL OR dispatch_lease_until <= ?)`,
        );
        const claimableIds: number[] = [];
        let terminalized = 0;
        for (const candidate of candidates) {
          if (
            candidate.dispatch_lease_until !== null &&
            candidate.dispatch_lease_until > canonicalCheckedAt
          ) {
            continue;
          }
          const error =
            candidate.created_at < cutoff
              ? "automatic retry window expired"
              : candidate.attempts >= 9007199254740991
                ? "delivery attempt limit exhausted"
                : null;
          if (error === null) {
            claimableIds.push(candidate.id);
          } else {
            terminalized += terminalize.run(
              error,
              candidate.id,
              canonicalCheckedAt,
              cutoff,
              canonicalCheckedAt,
            ).changes;
          }
        }
        const last = candidates.at(-1);
        return {
          inspected: candidates.length,
          terminalized,
          claimableIds,
          cursor:
            last === undefined
              ? canonicalAfter
              : { nextAttempt: last.next_attempt, id: last.id },
        };
      })
      .immediate();
  }

  /**
   * Atomically leases deliverable due work. A crashed process leaves the row
   * retryable as soon as the bounded lease expires, while concurrent dispatcher
   * ticks cannot observe the same row.
   */
  public claimDue(
    claimedAt: string,
    leaseUntil: string,
    leaseId: string,
    limit: number,
  ): readonly StoredOutboxRow[] {
    const prepared = this.prepareDue(claimedAt, limit);
    return this.claimPrepared(
      prepared.claimableIds,
      claimedAt,
      leaseUntil,
      leaseId,
    );
  }

  public claimPrepared(
    ids: readonly number[],
    claimedAt: string,
    leaseUntil: string,
    leaseId: string,
  ): readonly StoredOutboxRow[] {
    const canonicalClaimedAt = timestamp(claimedAt, "claim timestamp");
    const canonicalLeaseUntil = timestamp(leaseUntil, "lease timestamp");
    if (canonicalLeaseUntil <= canonicalClaimedAt) {
      throw new TypeError("lease timestamp must be after claim timestamp");
    }
    nonEmpty(leaseId, "lease id");
    if (ids.length === 0) return [];
    const uniqueIds = new Set(ids);
    if (uniqueIds.size !== ids.length) {
      throw new TypeError("prepared claim ids must be unique");
    }
    for (const id of ids) positiveInteger(id, "prepared claim id");
    return this.database
      .transaction(() => {
        const cutoff = new Date(
          Date.parse(canonicalClaimedAt) - 7 * 24 * 60 * 60_000,
        ).toISOString();
        const claim = this.database.prepare(
          `UPDATE webhook_outbox
           SET dispatch_lease_id = ?, dispatch_lease_until = ?
           WHERE id = ? AND state IN ('pending', 'retry')
             AND next_attempt <= ?
             AND created_at >= ? AND attempts < 9007199254740991
             AND (dispatch_lease_until IS NULL OR dispatch_lease_until <= ?)`,
        );
        const claimed: StoredOutboxRow[] = [];
        for (const id of ids) {
          const result = claim.run(
            leaseId,
            canonicalLeaseUntil,
            id,
            canonicalClaimedAt,
            cutoff,
            canonicalClaimedAt,
          );
          if (result.changes !== 1) continue;
          const row = this.getById(id);
          if (row !== null) claimed.push(row);
        }
        return claimed;
      })
      .immediate();
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

  public requestRedrive(input: {
    readonly outboxId: number;
    readonly deliveryId: string;
    readonly requestedAt: string;
    readonly secrets: Pick<SecretStore, "references" | "resolve">;
  }): StoredWebhookRedrive {
    positiveInteger(input.outboxId, "outbox id");
    const deliveryId = uuid(input.deliveryId, "redrive delivery id");
    const requestedAt = timestamp(
      input.requestedAt,
      "redrive request timestamp",
    );
    return this.database
      .transaction(() => {
        const source = this.database
          .prepare(
            `SELECT o.body, o.state, k.webhook_mode, k.webhook_target_url,
                    k.webhook_secret_ref
             FROM webhook_outbox AS o
             INNER JOIN project_ingest_keys AS k
               ON k.project_id = o.project_id AND k.environment = o.environment
             WHERE o.id = ?`,
          )
          .get(input.outboxId) as
          | {
              body: Buffer;
              state: StoredOutboxRow["state"];
              webhook_mode: "disabled" | "live";
              webhook_target_url: string | null;
              webhook_secret_ref: string | null;
            }
          | undefined;
        if (source === undefined) throw new WebhookRedriveNotFoundError();
        if (source.state !== "dead_letter")
          throw new WebhookRedriveConflictError();
        if (
          source.webhook_mode !== "live" ||
          source.webhook_target_url === null ||
          source.webhook_secret_ref === null
        ) {
          throw new WebhookRedriveConflictError();
        }
        const destination = validateWebhookDestination(
          source.webhook_target_url,
          source.webhook_secret_ref,
          input.secrets,
        );
        const signature = signWebhookBody(
          source.body,
          input.secrets.resolve(destination.secretRef),
        );
        const result = this.database
          .prepare(
            `INSERT INTO webhook_redrives(
               delivery_id, original_outbox_id, target_url, secret_ref,
               signature, state, attempts, dispatch_lease_id,
               dispatch_lease_until, requested_at, attempted_at, last_error
             ) VALUES (?, ?, ?, ?, ?, 'pending', 0, NULL, NULL, ?, NULL, NULL)`,
          )
          .run(
            deliveryId,
            input.outboxId,
            destination.targetUrl,
            destination.secretRef,
            signature,
            requestedAt,
          );
        return requireRedrive(
          this.getRedriveById(
            safeInteger(result.lastInsertRowid, "redrive id"),
          ),
        );
      })
      .immediate();
  }

  public getRedriveById(id: number): StoredWebhookRedrive | null {
    const row = this.database
      .prepare(`SELECT ${REDRIVE_COLUMNS} FROM webhook_redrives WHERE id = ?`)
      .get(id) as RedriveRow | undefined;
    return row === undefined ? null : mapRedrive(row);
  }

  public listRedrives(outboxId: number): readonly StoredWebhookRedrive[] {
    const rows = this.database
      .prepare(
        `SELECT ${REDRIVE_COLUMNS}
         FROM webhook_redrives
         WHERE original_outbox_id = ?
         ORDER BY requested_at, id`,
      )
      .all(outboxId) as RedriveRow[];
    return rows.map(mapRedrive);
  }

  public claimPendingRedrives(
    claimedAt: string,
    leaseUntil: string,
    leaseId: string,
    limit: number,
  ): readonly ClaimedWebhookRedrive[] {
    const canonicalClaimedAt = timestamp(claimedAt, "redrive claim timestamp");
    const canonicalLeaseUntil = timestamp(
      leaseUntil,
      "redrive lease timestamp",
    );
    if (canonicalLeaseUntil <= canonicalClaimedAt) {
      throw new TypeError(
        "redrive lease timestamp must be after claim timestamp",
      );
    }
    nonEmpty(leaseId, "redrive lease id");
    positiveInteger(limit, "redrive claim limit");
    return this.database
      .transaction(() => {
        const ids = this.database
          .prepare(
            `SELECT id
             FROM webhook_redrives
             WHERE state = 'pending'
               AND requested_at <= ?
               AND (dispatch_lease_until IS NULL OR dispatch_lease_until <= ?)
             ORDER BY requested_at, id
             LIMIT ?`,
          )
          .all(canonicalClaimedAt, canonicalClaimedAt, limit) as {
          id: number;
        }[];
        const claim = this.database.prepare(
          `UPDATE webhook_redrives
           SET dispatch_lease_id = ?, dispatch_lease_until = ?
           WHERE id = ? AND state = 'pending'
             AND (dispatch_lease_until IS NULL OR dispatch_lease_until <= ?)`,
        );
        const select = this.database.prepare(
          `SELECT ${REDRIVE_JOIN_COLUMNS}, o.body
           FROM webhook_redrives AS r
           INNER JOIN webhook_outbox AS o ON o.id = r.original_outbox_id
           WHERE r.id = ?`,
        );
        const claimed: ClaimedWebhookRedrive[] = [];
        for (const candidate of ids) {
          if (
            claim.run(
              leaseId,
              canonicalLeaseUntil,
              candidate.id,
              canonicalClaimedAt,
            ).changes !== 1
          ) {
            continue;
          }
          const row = select.get(candidate.id) as RedriveRow | undefined;
          if (row?.body !== undefined) {
            claimed.push({ ...mapRedrive(row), body: row.body });
          }
        }
        return claimed;
      })
      .immediate();
  }

  public completeRedrive(
    id: number,
    leaseId: string,
    result: "delivered" | "dead_letter",
    attemptedAt: string,
    error: string | null,
  ): boolean {
    const failure =
      result === "dead_letter"
        ? boundedError(error ?? "delivery failed")
        : null;
    const update = this.database
      .prepare(
        `UPDATE webhook_redrives
         SET state = ?, attempts = 1, dispatch_lease_id = NULL,
             dispatch_lease_until = NULL, attempted_at = ?, last_error = ?
         WHERE id = ? AND state = 'pending' AND attempts = 0
           AND dispatch_lease_id = ?`,
      )
      .run(
        result,
        timestamp(attemptedAt, "redrive attempt timestamp"),
        failure,
        id,
        leaseId,
      );
    return update.changes === 1;
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
    environment: row.environment,
    destinationMode: row.destination_mode,
    targetUrl: row.target_url,
    secretRef: row.secret_ref,
    body: row.body,
    signature: row.signature,
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

function mapRedrive(row: RedriveRow): StoredWebhookRedrive {
  return {
    id: row.id,
    deliveryId: row.delivery_id,
    originalOutboxId: row.original_outbox_id,
    targetUrl: row.target_url,
    secretRef: row.secret_ref,
    signature: row.signature,
    state: row.state,
    attempts: row.attempts,
    dispatchLeaseId: row.dispatch_lease_id,
    dispatchLeaseUntil: row.dispatch_lease_until,
    requestedAt: row.requested_at,
    attemptedAt: row.attempted_at,
    lastError: row.last_error,
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

function isSignature(value: string | null): value is string {
  return value !== null && /^[0-9a-f]{64}$/u.test(value);
}

function uuid(value: string, field: string): string {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  ) {
    throw new TypeError(`${field} must be a UUID`);
  }
  return value.toLowerCase();
}

function requireRedrive(
  value: StoredWebhookRedrive | null,
): StoredWebhookRedrive {
  if (value === null) throw new Error("stored redrive is unavailable");
  return value;
}

function safeInteger(value: number | bigint, field: string): number {
  const converted = typeof value === "bigint" ? Number(value) : value;
  if (!Number.isSafeInteger(converted) || converted <= 0) {
    throw new RangeError(`${field} must be a positive safe integer`);
  }
  return converted;
}

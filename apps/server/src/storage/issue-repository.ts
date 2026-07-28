import {
  decideManualReopen,
  decideOccurrence,
  decideResolve,
  type FingerprintResult,
  type IssueSnapshot,
} from "@intexura-error-hub/domain";
import type { NormalizedEvent } from "@intexura-error-hub/protocol";
import type { ErrorHubDatabase } from "./database.js";
import { EventRepository } from "./event-repository.js";
import {
  OutboxRepository,
  type OutboxDraft,
  type OutboxTransition,
} from "./outbox-repository.js";

export interface RecordOccurrenceInput {
  readonly projectId: number;
  readonly event: NormalizedEvent;
  readonly fingerprint: FingerprintResult;
  readonly buildOutbox: (transition: OutboxTransition) => OutboxDraft;
}

export interface RecordOccurrenceResult {
  readonly duplicate: boolean;
  readonly issueId: number;
  readonly eventRowId: number;
  readonly generation: number;
  readonly outcome: "created" | "repeated" | "regressed";
  readonly outboxId: number | null;
}

export interface StoredIssue {
  readonly id: number;
  readonly projectId: number;
  readonly fingerprintVersion: number;
  readonly fingerprint: string;
  readonly fingerprintExplanation: readonly string[];
  readonly title: string;
  readonly status: "unresolved" | "resolved";
  readonly generation: number;
  readonly occurrenceCount: number;
  readonly firstSeen: string;
  readonly lastSeen: string;
  readonly lastReceivedAt: string;
  readonly highestLevel: NormalizedEvent["level"];
  readonly resolvedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface StoredIssueFacet {
  readonly facetType: "environment" | "release" | "service" | "level";
  readonly facetValue: string | null;
  readonly count: number;
  readonly lastSeen: string;
}

interface IssueRow {
  id: number;
  project_id: number;
  fingerprint_version: number;
  fingerprint: string;
  fingerprint_explanation_json: string;
  title: string;
  status: "unresolved" | "resolved";
  generation: number;
  occurrence_count: number;
  first_seen: string;
  last_seen: string;
  last_received_at: string;
  highest_level: NormalizedEvent["level"];
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
}

interface DuplicateRow {
  event_row_id: number;
  issue_id: number;
  issue_generation: number;
  outbox_id: number | null;
}

interface FacetRow {
  facet_type: StoredIssueFacet["facetType"];
  facet_value: string;
  facet_value_is_null: 0 | 1;
  occurrence_count: number;
  last_seen: string;
}

const ISSUE_COLUMNS = `
  id, project_id, fingerprint_version, fingerprint,
  fingerprint_explanation_json, title, status, generation, occurrence_count,
  first_seen, last_seen, last_received_at, highest_level, resolved_at,
  created_at, updated_at
`;

export class IssueRepository {
  private readonly events: EventRepository;
  private readonly outbox: OutboxRepository;

  public constructor(private readonly database: ErrorHubDatabase) {
    this.events = new EventRepository(database);
    this.outbox = new OutboxRepository(database);
  }

  public recordOccurrence(
    input: RecordOccurrenceInput,
  ): RecordOccurrenceResult {
    return this.database
      .transaction(() => this.recordOccurrenceInTransaction(input))
      .immediate();
  }

  public getById(issueId: number): StoredIssue | null {
    const row = this.database
      .prepare(`SELECT ${ISSUE_COLUMNS} FROM issues WHERE id = ?`)
      .get(issueId) as IssueRow | undefined;
    return row === undefined ? null : mapIssue(row);
  }

  public listFacets(issueId: number): readonly StoredIssueFacet[] {
    const rows = this.database
      .prepare(
        `SELECT facet_type, facet_value, facet_value_is_null,
                occurrence_count, last_seen
         FROM issue_facets
         WHERE issue_id = ?
         ORDER BY facet_type, facet_value_is_null, facet_value`,
      )
      .all(issueId) as FacetRow[];
    return rows.map((row) => ({
      facetType: row.facet_type,
      facetValue: row.facet_value_is_null === 1 ? null : row.facet_value,
      count: row.occurrence_count,
      lastSeen: row.last_seen,
    }));
  }

  public resolve(issueId: number, resolvedAt: string): StoredIssue | null {
    const canonicalResolvedAt = canonicalTimestamp(
      resolvedAt,
      "resolved timestamp",
    );
    return this.database
      .transaction(() => {
        const current = this.getById(issueId);
        if (current === null || current.status === "resolved") {
          return current;
        }
        const decision = decideResolve(
          {
            status: "unresolved",
            generation: current.generation,
            resolvedAt: null,
          },
          canonicalResolvedAt,
        );
        this.database
          .prepare(
            `UPDATE issues
           SET status = ?, resolved_at = ?, updated_at = ?
           WHERE id = ? AND status = 'unresolved'`,
          )
          .run(
            decision.next.status,
            decision.next.resolvedAt,
            canonicalResolvedAt,
            issueId,
          );
        return this.getById(issueId);
      })
      .immediate();
  }

  public reopen(issueId: number, reopenedAt: string): StoredIssue | null {
    const canonicalReopenedAt = canonicalTimestamp(
      reopenedAt,
      "reopen timestamp",
    );
    return this.database
      .transaction(() => {
        const current = this.getById(issueId);
        if (current === null || current.status === "unresolved") {
          return current;
        }
        const decision = decideManualReopen({
          status: "resolved",
          generation: current.generation,
          resolvedAt: requireNonNull(current.resolvedAt, "resolved timestamp"),
        });
        this.database
          .prepare(
            `UPDATE issues
           SET status = ?, resolved_at = NULL, updated_at = ?
           WHERE id = ? AND status = 'resolved'`,
          )
          .run(decision.next.status, canonicalReopenedAt, issueId);
        return this.getById(issueId);
      })
      .immediate();
  }

  public delete(issueId: number): boolean {
    return this.database
      .transaction(() => {
        const result = this.database
          .prepare("DELETE FROM issues WHERE id = ?")
          .run(issueId);
        return result.changes === 1;
      })
      .immediate();
  }

  private recordOccurrenceInTransaction(
    input: RecordOccurrenceInput,
  ): RecordOccurrenceResult {
    assertPositiveInteger(input.projectId, "project id");
    const eventId = requireNonEmpty(input.event.id, "event id");
    requireNonEmpty(input.event.environment, "event environment");
    const event: NormalizedEvent = {
      ...input.event,
      occurredAt: canonicalTimestamp(
        input.event.occurredAt,
        "event occurrence timestamp",
      ),
      receivedAt: canonicalTimestamp(
        input.event.receivedAt,
        "event receipt timestamp",
      ),
    };
    const storageInput: RecordOccurrenceInput = { ...input, event };
    assertFingerprint(input.fingerprint);

    const duplicate = this.database
      .prepare(
        `SELECT
           e.id AS event_row_id, e.issue_id, e.issue_generation,
           o.id AS outbox_id
         FROM events AS e
         LEFT JOIN webhook_outbox AS o
           ON o.issue_id = e.issue_id AND o.event_id = e.event_id
         WHERE e.project_id = ? AND e.event_id = ?`,
      )
      .get(input.projectId, eventId) as DuplicateRow | undefined;
    if (duplicate !== undefined) {
      return {
        duplicate: true,
        issueId: duplicate.issue_id,
        eventRowId: duplicate.event_row_id,
        generation: duplicate.issue_generation,
        outcome: "repeated",
        outboxId: duplicate.outbox_id,
      };
    }

    const existing = this.database
      .prepare(
        `SELECT ${ISSUE_COLUMNS}
         FROM issues
         WHERE project_id = ? AND fingerprint_version = ? AND fingerprint = ?`,
      )
      .get(
        input.projectId,
        input.fingerprint.version,
        input.fingerprint.digest,
      ) as IssueRow | undefined;
    const decision = decideOccurrence(
      existing === undefined ? null : snapshot(existing),
    );

    const issueId =
      existing === undefined
        ? this.insertIssue(storageInput, decision.next.generation)
        : this.updateIssue(existing, event, decision.next);
    const eventRowId = this.events.insert({
      projectId: input.projectId,
      issueId,
      issueGeneration: decision.next.generation,
      event,
      fingerprint: input.fingerprint,
    });
    this.incrementFacets(issueId, event);

    let outboxId: number | null = null;
    if (decision.outcome === "created" || decision.outcome === "regressed") {
      const transition: OutboxTransition = {
        issueId,
        projectId: input.projectId,
        eventId,
        generation: decision.next.generation,
        cause: decision.outcome,
      };
      const draft = input.buildOutbox(transition);
      outboxId = this.outbox.insert(transition, draft, event.receivedAt);
    }

    return {
      duplicate: false,
      issueId,
      eventRowId,
      generation: decision.next.generation,
      outcome: decision.outcome,
      outboxId,
    };
  }

  private insertIssue(
    input: RecordOccurrenceInput,
    generation: number,
  ): number {
    const result = this.database
      .prepare(
        `INSERT INTO issues (
           project_id, fingerprint_version, fingerprint,
           fingerprint_explanation_json, title, status, generation,
           occurrence_count, first_seen, last_seen, last_received_at,
           highest_level, resolved_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, 'unresolved', ?, 1, ?, ?, ?, ?, NULL, ?, ?)`,
      )
      .run(
        input.projectId,
        input.fingerprint.version,
        input.fingerprint.digest,
        JSON.stringify(input.fingerprint.explanation),
        input.event.title,
        generation,
        input.event.occurredAt,
        input.event.occurredAt,
        input.event.receivedAt,
        input.event.level,
        input.event.receivedAt,
        input.event.receivedAt,
      );
    return safeInteger(result.lastInsertRowid, "issue id");
  }

  private updateIssue(
    current: IssueRow,
    event: NormalizedEvent,
    next: IssueSnapshot,
  ): number {
    const title =
      event.receivedAt >= current.last_received_at
        ? event.title
        : current.title;
    this.database
      .prepare(
        `UPDATE issues
         SET title = ?, status = ?, generation = ?, occurrence_count = occurrence_count + 1,
             first_seen = min(first_seen, ?), last_seen = max(last_seen, ?),
             last_received_at = max(last_received_at, ?), highest_level = ?,
             resolved_at = ?, updated_at = max(updated_at, ?)
         WHERE id = ?`,
      )
      .run(
        title,
        next.status,
        next.generation,
        event.occurredAt,
        event.occurredAt,
        event.receivedAt,
        higherLevel(current.highest_level, event.level),
        next.resolvedAt,
        event.receivedAt,
        current.id,
      );
    return current.id;
  }

  private incrementFacets(issueId: number, event: NormalizedEvent): void {
    const upsert = this.database.prepare(
      `INSERT INTO issue_facets (
         issue_id, facet_type, facet_value, facet_value_is_null,
         occurrence_count, last_seen
       ) VALUES (?, ?, ?, ?, 1, ?)
       ON CONFLICT(issue_id, facet_type, facet_value, facet_value_is_null)
       DO UPDATE SET
         occurrence_count = issue_facets.occurrence_count + 1,
         last_seen = max(issue_facets.last_seen, excluded.last_seen)`,
    );
    const facets: readonly [StoredIssueFacet["facetType"], string | null][] = [
      ["environment", event.environment],
      ["release", event.release],
      ["service", event.serverName],
      ["level", event.level],
    ];
    for (const [type, value] of facets) {
      upsert.run(
        issueId,
        type,
        value ?? "",
        value === null ? 1 : 0,
        event.occurredAt,
      );
    }
  }
}

function mapIssue(row: IssueRow): StoredIssue {
  const explanation: unknown = JSON.parse(row.fingerprint_explanation_json);
  if (
    !Array.isArray(explanation) ||
    !explanation.every((entry) => typeof entry === "string")
  ) {
    throw new Error("stored fingerprint explanation is invalid");
  }
  return {
    id: row.id,
    projectId: row.project_id,
    fingerprintVersion: row.fingerprint_version,
    fingerprint: row.fingerprint,
    fingerprintExplanation: explanation,
    title: row.title,
    status: row.status,
    generation: row.generation,
    occurrenceCount: row.occurrence_count,
    firstSeen: row.first_seen,
    lastSeen: row.last_seen,
    lastReceivedAt: row.last_received_at,
    highestLevel: row.highest_level,
    resolvedAt: row.resolved_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function snapshot(row: IssueRow): IssueSnapshot {
  return row.status === "unresolved"
    ? { status: "unresolved", generation: row.generation, resolvedAt: null }
    : {
        status: "resolved",
        generation: row.generation,
        resolvedAt: requireNonNull(row.resolved_at, "resolved timestamp"),
      };
}

function higherLevel(
  left: NormalizedEvent["level"],
  right: NormalizedEvent["level"],
): NormalizedEvent["level"] {
  const rank = { warn: 0, error: 1, fatal: 2 } as const;
  return rank[left] >= rank[right] ? left : right;
}

function assertFingerprint(value: FingerprintResult): void {
  if (value.version !== 1 || !/^[a-f0-9]{64}$/.test(value.digest)) {
    throw new TypeError(
      "fingerprint must be a version 1 lowercase SHA-256 digest",
    );
  }
  if (!value.explanation.every((entry) => typeof entry === "string")) {
    throw new TypeError("fingerprint explanation must contain strings");
  }
}

function assertPositiveInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${field} must be a positive safe integer`);
  }
}

function requireNonEmpty(value: string | null, field: string): string {
  if (value === null || value.length === 0) {
    throw new TypeError(`${field} must not be empty`);
  }
  return value;
}

function requireNonNull<T>(value: T | null, field: string): T {
  if (value === null) throw new Error(`${field} is missing`);
  return value;
}

function canonicalTimestamp(value: string, field: string): string {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw new TypeError(`${field} must be an ISO timestamp`);
  }
  return new Date(milliseconds).toISOString();
}

function safeInteger(value: number | bigint, field: string): number {
  const converted = typeof value === "bigint" ? Number(value) : value;
  if (!Number.isSafeInteger(converted) || converted <= 0) {
    throw new RangeError(`${field} must be a positive safe integer`);
  }
  return converted;
}

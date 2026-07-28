import type { ErrorHubDatabase } from "../storage/database.js";
import {
  EventRepository,
  type StoredEvent,
} from "../storage/event-repository.js";
import {
  IssueRepository,
  type StoredIssue,
} from "../storage/issue-repository.js";
import { OutboxRepository } from "../storage/outbox-repository.js";
import {
  encodeCursor,
  encodeNullableFacetQueryValue,
  eventFilterPredicate,
  notFound,
  type PrivateFilters,
} from "./query.js";

interface IssueListRow {
  id: number;
  project_id: number;
  project_slug: string;
  project_name: string;
  title: string;
  status: "unresolved" | "resolved";
  generation: number;
  occurrence_count: number;
  matching_count: number;
  first_seen: string;
  last_seen: string;
  last_received_at: string;
  highest_level: "warn" | "error" | "fatal";
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
}

interface EventSummaryRow {
  id: number;
  event_id: string;
  issue_id: number;
  project_id: number;
  project_slug: string;
  issue_generation: number;
  environment: string;
  release: string | null;
  service: string | null;
  level: "warn" | "error" | "fatal";
  platform: string | null;
  title: string;
  message: string | null;
  exception_type: string | null;
  culprit: string | null;
  occurred_at: string;
  received_at: string;
  request_id: string | null;
  trace_id: string | null;
  task_id: string | null;
  truncated: 0 | 1;
}

export type IssueListItem = ReturnType<typeof mapIssueListRow>;
export type EventSummary = ReturnType<typeof mapEventSummary>;

export function listIssues(
  database: ErrorHubDatabase,
  filters: PrivateFilters,
  limit: number,
  cursor: { readonly timestamp: string; readonly id: number | string } | null,
): {
  readonly items: readonly IssueListItem[];
  readonly nextCursor: string | null;
} {
  const countPredicate = eventFilterPredicate(filters, {
    event: "count_event",
    issue: "i",
    project: "p",
  });
  const existencePredicate = eventFilterPredicate(filters, {
    event: "matching_event",
    issue: "i",
    project: "p",
  });
  const issueIndex =
    filters.status.length === 0
      ? "idx_issues_last_seen"
      : "idx_issues_status_last_seen";
  const cursorSql =
    cursor === null
      ? ""
      : "AND (i.last_seen < ? OR (i.last_seen = ? AND i.id < ?))";
  const parameters: unknown[] = [
    ...countPredicate.parameters,
    ...existencePredicate.parameters,
  ];
  if (cursor !== null)
    parameters.push(cursor.timestamp, cursor.timestamp, cursor.id);
  parameters.push(limit + 1);
  const rows = database
    .prepare(
      `SELECT i.id, i.project_id, p.slug AS project_slug, p.name AS project_name,
              i.title, i.status, i.generation, i.occurrence_count,
              (SELECT COUNT(*)
               FROM events AS count_event
               WHERE count_event.issue_id = i.id
                 AND ${countPredicate.sql}) AS matching_count,
              i.first_seen, i.last_seen,
              i.last_received_at, i.highest_level, i.resolved_at,
              i.created_at, i.updated_at
       FROM issues AS i INDEXED BY ${issueIndex}
       INNER JOIN projects AS p ON p.id = i.project_id
       WHERE EXISTS (
         SELECT 1
         FROM events AS matching_event
         WHERE matching_event.issue_id = i.id
           AND ${existencePredicate.sql}
       ) ${cursorSql}
       ORDER BY i.last_seen DESC, i.id DESC
       LIMIT ?`,
    )
    .all(...parameters) as IssueListRow[];
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    items: page.map(mapIssueListRow),
    nextCursor:
      hasMore && last !== undefined
        ? encodeCursor(last.last_seen, last.id)
        : null,
  };
}

export function getIssueDetail(database: ErrorHubDatabase, issueId: number) {
  const issue = new IssueRepository(database).getById(issueId);
  if (issue === null) throw notFound("Issue not found");
  const project = projectFor(database, issue.projectId);
  const facets = issueFacets(database, issueId);
  const outbox = new OutboxRepository(database);
  const deliveries = outbox.listByIssue(issueId).map((delivery) => ({
    id: delivery.id,
    deliveryId: delivery.deliveryId,
    generation: delivery.generation,
    cause: delivery.cause,
    state: delivery.state,
    attempts: delivery.attempts,
    nextAttempt: delivery.nextAttempt,
    lastError: delivery.lastError,
    createdAt: delivery.createdAt,
    deliveredAt: delivery.deliveredAt,
    redrives: outbox.listRedrives(delivery.id).map((redrive) => ({
      id: redrive.id,
      deliveryId: redrive.deliveryId,
      originalOutboxId: redrive.originalOutboxId,
      state: redrive.state,
      attempts: redrive.attempts,
      requestedAt: redrive.requestedAt,
      attemptedAt: redrive.attemptedAt,
      lastError: safeOperationalError(redrive.lastError),
    })),
  }));
  return {
    ...mapStoredIssue(issue),
    project,
    facets,
    deliveries,
  };
}

export function listIssueEvents(
  database: ErrorHubDatabase,
  issueId: number,
  limit: number,
  cursor: { readonly timestamp: string; readonly id: number | string } | null,
): {
  readonly items: readonly EventSummary[];
  readonly nextCursor: string | null;
} {
  if (new IssueRepository(database).getById(issueId) === null)
    throw notFound("Issue not found");
  const cursorSql =
    cursor === null
      ? ""
      : "AND (e.occurred_at < ? OR (e.occurred_at = ? AND e.event_id < ?))";
  const parameters: unknown[] = [issueId];
  if (cursor !== null)
    parameters.push(cursor.timestamp, cursor.timestamp, cursor.id);
  parameters.push(limit + 1);
  const rows = database
    .prepare(
      `SELECT e.id, e.event_id, e.issue_id, e.project_id, p.slug AS project_slug,
              e.issue_generation, e.environment, e.release, e.service, e.level,
              e.platform, e.title, e.message, e.exception_type, e.culprit,
              e.occurred_at, e.received_at, e.request_id, e.trace_id, e.task_id,
              e.truncated
       FROM events AS e
       INNER JOIN projects AS p ON p.id = e.project_id
       WHERE e.issue_id = ? ${cursorSql}
       ORDER BY e.occurred_at DESC, e.event_id DESC
       LIMIT ?`,
    )
    .all(...parameters) as EventSummaryRow[];
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    items: page.map(mapEventSummary),
    nextCursor:
      hasMore && last !== undefined
        ? encodeCursor(last.occurred_at, last.event_id)
        : null,
  };
}

export function getEventByLocator(
  database: ErrorHubDatabase,
  rowId: number,
): StoredEvent {
  const event = new EventRepository(database).getByRowId(rowId);
  if (event === null) throw notFound("Event not found");
  return event;
}

export function eventResponse(event: StoredEvent) {
  return {
    id: event.rowId,
    eventId: event.eventId,
    issueId: event.issueId,
    projectId: event.projectId,
    issueGeneration: event.issueGeneration,
    environment: event.environment,
    release: event.release,
    service: event.service,
    level: event.level,
    platform: event.platform,
    title: event.title,
    message: event.message,
    exceptionType: event.exceptionType,
    culprit: event.culprit,
    occurredAt: event.occurredAt,
    receivedAt: event.receivedAt,
    requestId: event.requestId,
    traceId: event.traceId,
    taskId: event.taskId,
    truncated: event.truncated,
    normalized: event.payload,
  };
}

export function facetsForFilters(
  database: ErrorHubDatabase,
  filters: PrivateFilters,
) {
  const predicate = eventFilterPredicate(filters, {
    event: "e",
    issue: "i",
    project: "p",
  });
  const common = `FROM events AS e
    INNER JOIN issues AS i ON i.id = e.issue_id
    INNER JOIN projects AS p ON p.id = e.project_id
    WHERE ${predicate.sql}`;
  const projectRows = database
    .prepare(
      `SELECT p.slug AS value, p.name AS label, COUNT(e.id) AS count ${common}
       GROUP BY p.id ORDER BY p.name, p.slug`,
    )
    .all(...predicate.parameters) as {
    value: string;
    label: string;
    count: number;
  }[];
  return {
    project: projectRows.map((row) => ({ ...row, queryValue: row.value })),
    release: scalarFacet(database, "e.release", common, predicate.parameters, {
      nullable: true,
      unknownVersion: true,
    }),
    environment: scalarFacet(
      database,
      "e.environment",
      common,
      predicate.parameters,
      { nullable: false, unknownVersion: false },
    ),
    service: scalarFacet(database, "e.service", common, predicate.parameters, {
      nullable: true,
      unknownVersion: false,
    }),
    level: scalarFacet(database, "e.level", common, predicate.parameters, {
      nullable: false,
      unknownVersion: false,
    }),
    status: scalarFacet(database, "i.status", common, predicate.parameters, {
      nullable: false,
      unknownVersion: false,
    }),
  };
}

function issueFacets(database: ErrorHubDatabase, issueId: number) {
  const grouped: Record<string, unknown[]> = {
    environment: [],
    release: [],
    service: [],
    level: [],
  };
  for (const facet of new IssueRepository(database).listFacets(issueId)) {
    const nullableFacet =
      facet.facetType === "release" || facet.facetType === "service";
    const unknownRelease =
      facet.facetType === "release" && facet.facetValue === null;
    grouped[facet.facetType]!.push({
      value: facet.facetValue,
      queryValue: nullableFacet
        ? encodeNullableFacetQueryValue(facet.facetValue)
        : facet.facetValue,
      label: unknownRelease ? "Unknown version" : facet.facetValue,
      count: facet.count,
      lastSeen: facet.lastSeen,
    });
  }
  return grouped;
}

function scalarFacet(
  database: ErrorHubDatabase,
  column: string,
  common: string,
  parameters: readonly unknown[],
  options: { readonly nullable: boolean; readonly unknownVersion: boolean },
) {
  const rows = database
    .prepare(
      `SELECT ${column} AS value, COUNT(e.id) AS count ${common}
       GROUP BY ${column}
       ORDER BY ${column} IS NULL DESC, ${column}`,
    )
    .all(...parameters) as { value: string | null; count: number }[];
  return rows.map((row) => {
    const unknown = row.value === null;
    return {
      value: row.value,
      queryValue: options.nullable
        ? encodeNullableFacetQueryValue(row.value)
        : row.value,
      label: unknown && options.unknownVersion ? "Unknown version" : row.value,
      count: row.count,
    };
  });
}

function mapIssueListRow(row: IssueListRow) {
  return {
    id: row.id,
    project: {
      id: String(row.project_id),
      slug: row.project_slug,
      name: row.project_name,
    },
    title: row.title,
    status: row.status,
    generation: row.generation,
    count: row.occurrence_count,
    occurrenceCount: row.occurrence_count,
    matchingCount: row.matching_count,
    firstSeen: row.first_seen,
    lastSeen: row.last_seen,
    lastReceivedAt: row.last_received_at,
    highestLevel: row.highest_level,
    resolvedAt: row.resolved_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapStoredIssue(issue: StoredIssue) {
  return {
    id: issue.id,
    title: issue.title,
    status: issue.status,
    generation: issue.generation,
    count: issue.occurrenceCount,
    occurrenceCount: issue.occurrenceCount,
    firstSeen: issue.firstSeen,
    lastSeen: issue.lastSeen,
    lastReceivedAt: issue.lastReceivedAt,
    highestLevel: issue.highestLevel,
    resolvedAt: issue.resolvedAt,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
  };
}

function mapEventSummary(row: EventSummaryRow) {
  return {
    id: row.event_id,
    rowId: row.id,
    issueId: row.issue_id,
    projectId: row.project_id,
    projectSlug: row.project_slug,
    issueGeneration: row.issue_generation,
    environment: row.environment,
    release: row.release,
    service: row.service,
    level: row.level,
    platform: row.platform,
    title: row.title,
    message: row.message,
    exceptionType: row.exception_type,
    culprit: row.culprit,
    occurredAt: row.occurred_at,
    receivedAt: row.received_at,
    requestId: row.request_id,
    traceId: row.trace_id,
    taskId: row.task_id,
    truncated: row.truncated === 1,
  };
}

function projectFor(database: ErrorHubDatabase, projectId: number) {
  const row = database
    .prepare("SELECT id, slug, name FROM projects WHERE id = ?")
    .get(projectId) as { id: number; slug: string; name: string } | undefined;
  if (row === undefined) throw new Error("stored issue project is missing");
  return { id: String(row.id), slug: row.slug, name: row.name };
}

function safeOperationalError(value: string | null): string | null {
  if (value === null) return null;
  return value
    .replaceAll(/https?:\/\/\S+/giu, "[REDACTED_URL]")
    .replaceAll(/\b(?:bearer|token|secret)\s*[:=]?\s*\S+/giu, "[REDACTED]")
    .slice(0, 256);
}

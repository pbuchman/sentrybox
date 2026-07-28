import type { NormalizedEvent } from "@intexura-error-hub/protocol";
import type { ErrorHubDatabase } from "../storage/database.js";
import {
  EventRepository,
  type StoredEvent,
} from "../storage/event-repository.js";
import {
  IssueRepository,
  type StoredIssue,
} from "../storage/issue-repository.js";

export interface SentryFacadeOptions {
  readonly database: ErrorHubDatabase;
  readonly privateOrigin: URL;
  readonly organizationSlug: string;
  readonly now: () => Date;
}

export interface SentryIssueContext {
  readonly issue: StoredIssue;
  readonly project: {
    readonly id: number;
    readonly slug: string;
    readonly name: string;
  };
  readonly latest: StoredEvent;
}

export function resolveIssueContext(
  options: SentryFacadeOptions,
  organizationSlug: string,
  locator: string,
): SentryIssueContext | null {
  if (organizationSlug !== options.organizationSlug) return null;
  const issueId = issueIdFromLocator(locator);
  if (issueId === null) return null;
  const issue = new IssueRepository(options.database).getById(issueId);
  if (issue === null) return null;
  const project = options.database
    .prepare("SELECT id, slug, name FROM projects WHERE id = ?")
    .get(issue.projectId) as
    | { id: number; slug: string; name: string }
    | undefined;
  const latestRow = options.database
    .prepare(
      `SELECT id FROM events
       WHERE issue_id = ?
       ORDER BY occurred_at DESC, event_id DESC, id DESC
       LIMIT 1`,
    )
    .get(issue.id) as { id: number } | undefined;
  if (project === undefined || latestRow === undefined) return null;
  const latest = new EventRepository(options.database).getByRowId(latestRow.id);
  return latest === null ? null : { issue, project, latest };
}

export function issuePayload(
  options: SentryFacadeOptions,
  context: SentryIssueContext,
) {
  const { issue, project, latest } = context;
  return {
    id: String(issue.id),
    shortId: issueShortId(issue.id),
    title: issue.title,
    firstSeen: issue.firstSeen,
    lastSeen: issue.lastSeen,
    count: String(issue.occurrenceCount),
    userCount: 0,
    permalink: issuePermalink(options, issue.id),
    project: { id: String(project.id), slug: project.slug, name: project.name },
    platform: latest.platform,
    status: issue.status,
    culprit: eventCulprit(latest),
    type: "error",
    issueCategory: "error",
  };
}

export function eventPayload(
  options: SentryFacadeOptions,
  context: SentryIssueContext,
  event: StoredEvent,
) {
  const normalized = event.payload;
  const entries: Array<{ readonly type: string; readonly data: unknown }> = [];
  if (normalized.exception !== null) {
    entries.push({
      type: "exception",
      data: {
        values: [
          {
            type: normalized.exception.type,
            value: normalized.exception.value,
            mechanism: normalized.exception.mechanism,
            stacktrace: {
              frames: normalized.exception.frames.map(sentryFrame),
            },
          },
        ],
      },
    });
  }
  if (normalized.breadcrumbs.length > 0) {
    entries.push({
      type: "breadcrumbs",
      data: { values: normalized.breadcrumbs.map(sentryBreadcrumb) },
    });
  }
  if (normalized.message !== null) {
    entries.push({
      type: "message",
      data: {
        formatted: normalized.message,
        message: normalized.message,
        params: [],
      },
    });
  }
  return {
    id: event.eventId,
    eventID: event.eventId,
    title: event.title,
    message: event.message,
    platform: event.platform,
    type: "error",
    culprit: eventCulprit(event),
    dateCreated: event.occurredAt,
    dateReceived: event.receivedAt,
    entries,
    contexts: sentryContexts(normalized),
    context: normalizedPayloadRecord(normalized, "extras"),
    tags: sentryTags(event),
    occurrenceCount: context.issue.occurrenceCount,
    issue: issueShortId(context.issue.id),
    project: context.project.slug,
    permalink: eventPermalink(options, context.issue.id, event.eventId),
    evidence: {
      requestId: event.requestId,
      traceId: event.traceId,
      taskId: event.taskId,
      generation: event.issueGeneration,
      retainedOccurrenceCount: context.issue.occurrenceCount,
    },
  };
}

export function issueShortId(issueId: number): string {
  return `INTEXURA-HUB-${String(issueId)}`;
}

export function findEventForIssue(
  database: ErrorHubDatabase,
  issueId: number,
  eventId: string,
): StoredEvent | null {
  const row = database
    .prepare("SELECT id FROM events WHERE issue_id = ? AND event_id = ?")
    .get(issueId, eventId) as { id: number } | undefined;
  return row === undefined
    ? null
    : new EventRepository(database).getByRowId(row.id);
}

export function sentryNotFound(reply: import("fastify").FastifyReply) {
  return reply
    .code(404)
    .type("application/json; charset=utf-8")
    .send({ detail: "Unsupported endpoint" });
}

function issueIdFromLocator(locator: string): number | null {
  const raw = locator.match(/^INTEXURA-HUB-([1-9]\d*)$/u)?.[1] ?? locator;
  if (!/^[1-9]\d*$/u.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) ? id : null;
}

function issuePermalink(options: SentryFacadeOptions, issueId: number): string {
  return new URL(
    `/organizations/${options.organizationSlug}/issues/${String(issueId)}/`,
    options.privateOrigin,
  ).toString();
}

function eventPermalink(
  options: SentryFacadeOptions,
  issueId: number,
  eventId: string,
): string {
  return new URL(
    `/organizations/${options.organizationSlug}/issues/${String(issueId)}/events/${encodeURIComponent(eventId)}/`,
    options.privateOrigin,
  ).toString();
}

function eventCulprit(event: StoredEvent): string | null {
  const frames = event.payload.exception?.frames ?? [];
  for (let index = frames.length - 1; index >= 0; index -= 1) {
    const frame = frames[index];
    if (frame?.in_app !== true) continue;
    for (const key of ["function", "module", "filename"] as const) {
      const value = frame[key];
      if (typeof value === "string" && value.length > 0) return value;
    }
  }
  return event.culprit;
}

function sentryFrame(frame: Readonly<Record<string, unknown>>) {
  return {
    filename: stringOrNull(frame.filename),
    function: stringOrNull(frame.function),
    lineNo: numberOrNull(frame.lineno),
    colNo: numberOrNull(frame.colno),
    absPath: stringOrNull(frame.abs_path),
    module: stringOrNull(frame.module),
    context: [],
    inApp: frame.in_app === true,
  };
}

function sentryBreadcrumb(value: Readonly<Record<string, unknown>>) {
  return {
    timestamp: stringOrNull(value.timestamp),
    type: stringOrNull(value.type),
    category: stringOrNull(value.category),
    level: stringOrNull(value.level),
    message: stringOrNull(value.message),
    data: null,
  };
}

function sentryContexts(
  event: NormalizedEvent,
): Readonly<Record<string, Readonly<Record<string, unknown>>>> {
  const contexts = normalizedPayloadRecord(event, "contexts");
  return Object.fromEntries(
    Object.entries(contexts)
      .filter(
        (entry): entry is [string, Readonly<Record<string, unknown>>] =>
          typeof entry[1] === "object" &&
          entry[1] !== null &&
          !Array.isArray(entry[1]),
      )
      .map(([name, value]) => [
        name,
        {
          type:
            name === "runtime" || name === "trace" || name === "os"
              ? name
              : "default",
          ...value,
        },
      ]),
  );
}

function normalizedPayloadRecord(
  event: NormalizedEvent,
  key: string,
): Readonly<Record<string, unknown>> {
  const value = event.payload[key];
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}

function sentryTags(
  event: StoredEvent,
): readonly { readonly key: string; readonly value: string | null }[] {
  const tags = new Map<string, string | null>(
    Object.entries(event.payload.tags),
  );
  tags.set("environment", event.environment);
  tags.set("release", event.release);
  tags.set("service", event.service);
  tags.set("level", event.level);
  return [...tags.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, value]) => ({ key, value }));
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

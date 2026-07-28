import type { FastifyInstance } from "fastify";
import {
  EventRepository,
  type StoredEvent,
} from "../storage/event-repository.js";
import { PrivateApiError } from "../api/query.js";
import {
  eventPayload,
  findEventForIssue,
  resolveIssueContext,
  sentryNotFound,
  type SentryFacadeOptions,
  type SentryIssueContext,
} from "./model.js";

interface IssueParams {
  readonly Params: { readonly org: string; readonly issueId: string };
}

interface EventParams extends IssueParams {
  readonly Params: IssueParams["Params"] & { readonly eventId: string };
}

export function registerSentryEventRoutes(
  app: FastifyInstance,
  options: SentryFacadeOptions,
): void {
  app.get<IssueParams>(
    "/api/0/organizations/:org/issues/:issueId/events/latest/",
    async (request, reply) => {
      const context = resolveIssueContext(
        options,
        request.params.org,
        request.params.issueId,
      );
      return context === null
        ? sentryNotFound(reply)
        : eventPayload(options, context, context.latest);
    },
  );

  app.get<EventParams>(
    "/api/0/organizations/:org/issues/:issueId/events/:eventId/",
    async (request, reply) => {
      const context = resolveIssueContext(
        options,
        request.params.org,
        request.params.issueId,
      );
      if (context === null) return sentryNotFound(reply);
      const event = findEventForIssue(
        options.database,
        context.issue.id,
        request.params.eventId,
      );
      return event === null
        ? sentryNotFound(reply)
        : eventPayload(options, context, event);
    },
  );

  app.get<IssueParams>(
    "/api/0/organizations/:org/issues/:issueId/events/",
    async (request, reply) => {
      const context = resolveIssueContext(
        options,
        request.params.org,
        request.params.issueId,
      );
      if (context === null) return sentryNotFound(reply);
      const query = parseListQuery(request.query, options);
      const rows = options.database
        .prepare(
          `SELECT id FROM events
           WHERE issue_id = ? ${query.whereSql}
           ORDER BY occurred_at ${query.direction}, event_id ${query.direction}, id ${query.direction}
           LIMIT ?`,
        )
        .all(context.issue.id, ...query.parameters, query.limit) as {
        id: number;
      }[];
      const repository = new EventRepository(options.database);
      const events = rows
        .map((row) => repository.getByRowId(row.id))
        .filter((event): event is StoredEvent => event !== null)
        .map((event) => flatSearchEvent(options, context, event));
      return reply.type("application/json; charset=utf-8").send(events);
    },
  );
}

function flatSearchEvent(
  options: SentryFacadeOptions,
  context: SentryIssueContext,
  event: StoredEvent,
) {
  const payload = eventPayload(options, context, event);
  return {
    id: event.eventId,
    eventID: event.eventId,
    issue: payload.issue,
    project: payload.project,
    title: event.title,
    level: event.level,
    "error.type": event.exceptionType,
    "error.value": event.payload.exception?.value ?? null,
    message: event.message,
    culprit: payload.culprit,
    timestamp: event.occurredAt,
    environment: event.environment,
    release: event.release,
    service: event.service,
    "count()": context.issue.occurrenceCount,
    permalink: payload.permalink,
  };
}

function parseListQuery(
  query: unknown,
  options: SentryFacadeOptions,
): {
  readonly whereSql: string;
  readonly parameters: readonly unknown[];
  readonly limit: number;
  readonly direction: "ASC" | "DESC";
} {
  const record =
    typeof query === "object" && query !== null && !Array.isArray(query)
      ? (query as Record<string, unknown>)
      : {};
  const perPage = stringValue(record.per_page) ?? "50";
  if (!/^[1-9]\d*$/u.test(perPage)) return invalidListQuery();
  const limit = Number(perPage);
  if (!Number.isSafeInteger(limit) || limit > 100) return invalidListQuery();
  const sort = stringValue(record.sort) ?? "-timestamp";
  if (sort !== "-timestamp" && sort !== "timestamp") return invalidListQuery();
  const clauses: string[] = [];
  const parameters: unknown[] = [];
  const search = stringValue(record.query)?.trim() ?? "";
  if (search.length > 1_024) return invalidListQuery();
  for (const token of search
    .split(/\s+/u)
    .filter((value) => value.length > 0)) {
    const match = token.match(/^(environment|release|service|level):(.+)$/u);
    if (match === null) continue;
    const column = match[1];
    const value = match[2];
    if (column === undefined || value === undefined) continue;
    clauses.push(`${column} = ?`);
    parameters.push(value.replace(/^"|"$/gu, ""));
  }
  const statsPeriod = stringValue(record.statsPeriod);
  if (statsPeriod !== undefined) {
    const match = statsPeriod.match(/^(\d+)([hdw])$/u);
    if (match === null) return invalidListQuery();
    const amount = Number(match[1]);
    const unit = match[2];
    const multiplier =
      unit === "h" ? 3_600_000 : unit === "d" ? 86_400_000 : 604_800_000;
    const now = options.now();
    if (!Number.isFinite(now.getTime()) || !Number.isSafeInteger(amount))
      return invalidListQuery();
    clauses.push("occurred_at >= ?");
    parameters.push(
      new Date(now.getTime() - amount * multiplier).toISOString(),
    );
  }
  return {
    whereSql: clauses.length === 0 ? "" : `AND ${clauses.join(" AND ")}`,
    parameters,
    limit,
    direction: sort === "-timestamp" ? "DESC" : "ASC",
  };
}

function invalidListQuery(): never {
  throw new PrivateApiError(
    400,
    "invalid_request",
    "Sentry event query is invalid",
  );
}

function stringValue(value: unknown): string | undefined {
  const selected = Array.isArray(value) ? value[0] : value;
  return typeof selected === "string" ? selected : undefined;
}

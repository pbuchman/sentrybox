import { Readable } from "node:stream";
import { createGunzip, createGzip, gunzipSync } from "node:zlib";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { ErrorHubDatabase } from "../storage/database.js";
import { IssueRepository } from "../storage/issue-repository.js";
import {
  eventFilterPredicate,
  notFound,
  parseFilters,
  positiveId,
  type PrivateFilters,
} from "./query.js";

interface IdParams {
  readonly Params: { readonly id: string };
}

export interface ExportRouteOptions {
  readonly database: ErrorHubDatabase;
  readonly batchSize?: number;
  readonly onBatch?: (size: number) => void;
}

interface PayloadRow {
  readonly id: number;
  readonly occurred_at: string;
  readonly event_id: string;
  readonly payload_gzip: Buffer;
}

export function registerExportRoutes(
  app: FastifyInstance,
  options: ExportRouteOptions,
): void {
  const database = options.database;
  const batchSize = boundedBatchSize(options.batchSize ?? 25);
  app.get<IdParams>("/api/events/:id/download", async (request, reply) => {
    const rowId = positiveId(request.params.id, "event locator");
    const row = database
      .prepare("SELECT event_id, payload_gzip FROM events WHERE id = ?")
      .get(rowId) as { event_id: string; payload_gzip: Buffer } | undefined;
    if (row === undefined) throw notFound("Event not found");
    reply.header("Content-Type", "application/json; charset=utf-8");
    reply.header(
      "Content-Disposition",
      `attachment; filename=event-${safeFilename(row.event_id)}.json`,
    );
    reply.removeHeader("Content-Length");
    return sendAbortable(
      request.raw,
      reply,
      Readable.from([row.payload_gzip]).pipe(createGunzip()),
    );
  });

  app.get<IdParams>("/api/issues/:id/download", async (request, reply) => {
    const issueId = positiveId(request.params.id, "issue id");
    if (new IssueRepository(database).getById(issueId) === null)
      throw notFound("Issue not found");
    const readBatch = issueBatchReader(database, issueId, batchSize);
    return sendNdjsonGzip(
      request.raw,
      reply,
      readBatch,
      `issue-${String(issueId)}.ndjson.gz`,
      options.onBatch,
    );
  });

  app.get("/api/export", async (request, reply) =>
    sendNdjsonGzip(
      request.raw,
      reply,
      filteredBatchReader(database, parseFilters(request.query), batchSize),
      "sentrybox-export.ndjson.gz",
      options.onBatch,
    ),
  );
}

function sendNdjsonGzip(
  request: import("node:http").IncomingMessage,
  reply: FastifyReply,
  readBatch: (cursor: PayloadCursor | null) => readonly PayloadRow[],
  filename: string,
  onBatch: ((size: number) => void) | undefined,
) {
  async function* jsonLines(): AsyncGenerator<Buffer> {
    let cursor: PayloadCursor | null = null;
    while (true) {
      const rows = readBatch(cursor);
      onBatch?.(rows.length);
      if (rows.length === 0) return;
      for (const row of rows) {
        yield gunzipSync(row.payload_gzip);
        yield Buffer.from("\n", "utf8");
        cursor = {
          occurredAt: row.occurred_at,
          eventId: row.event_id,
          id: row.id,
        };
      }
    }
  }
  reply.header("Content-Type", "application/x-ndjson; charset=utf-8");
  reply.header("Content-Encoding", "gzip");
  reply.header("Content-Disposition", `attachment; filename=${filename}`);
  reply.removeHeader("Content-Length");
  return sendAbortable(
    request,
    reply,
    Readable.from(jsonLines()).pipe(createGzip({ level: 9 })),
  );
}

interface PayloadCursor {
  readonly occurredAt: string;
  readonly eventId: string;
  readonly id: number;
}

function issueBatchReader(
  database: ErrorHubDatabase,
  issueId: number,
  batchSize: number,
): (cursor: PayloadCursor | null) => readonly PayloadRow[] {
  const upper = exportUpperBound(database, "e.issue_id = ?", [issueId]);
  if (upper === null) return () => [];
  return (cursor) => {
    const lowerSql =
      cursor === null
        ? ""
        : "AND (e.occurred_at, e.event_id, e.id) > (?, ?, ?)";
    const parameters: unknown[] = [issueId];
    if (cursor !== null)
      parameters.push(cursor.occurredAt, cursor.eventId, cursor.id);
    parameters.push(upper.occurredAt, upper.eventId, upper.id, batchSize);
    return database
      .prepare(
        `SELECT e.id, e.occurred_at, e.event_id, e.payload_gzip
         FROM events AS e
         WHERE e.issue_id = ? ${lowerSql}
           AND (e.occurred_at, e.event_id, e.id) <= (?, ?, ?)
         ORDER BY e.occurred_at, e.event_id, e.id
         LIMIT ?`,
      )
      .all(...parameters) as PayloadRow[];
  };
}

function filteredBatchReader(
  database: ErrorHubDatabase,
  filters: PrivateFilters,
  batchSize: number,
): (cursor: PayloadCursor | null) => readonly PayloadRow[] {
  const predicate = eventFilterPredicate(filters, {
    event: "e",
    issue: "i",
    project: "p",
  });
  const joins =
    "INNER JOIN issues AS i ON i.id = e.issue_id INNER JOIN projects AS p ON p.id = e.project_id";
  const upper = exportUpperBound(
    database,
    predicate.sql,
    predicate.parameters,
    joins,
  );
  if (upper === null) return () => [];
  return (cursor) => {
    const lowerSql =
      cursor === null
        ? ""
        : "AND (e.occurred_at, e.event_id, e.id) > (?, ?, ?)";
    const parameters: unknown[] = [...predicate.parameters];
    if (cursor !== null)
      parameters.push(cursor.occurredAt, cursor.eventId, cursor.id);
    parameters.push(upper.occurredAt, upper.eventId, upper.id, batchSize);
    return database
      .prepare(
        `SELECT e.id, e.occurred_at, e.event_id, e.payload_gzip
         FROM events AS e ${joins}
         WHERE ${predicate.sql} ${lowerSql}
           AND (e.occurred_at, e.event_id, e.id) <= (?, ?, ?)
         ORDER BY e.occurred_at, e.event_id, e.id
         LIMIT ?`,
      )
      .all(...parameters) as PayloadRow[];
  };
}

function exportUpperBound(
  database: ErrorHubDatabase,
  predicate: string,
  parameters: readonly unknown[],
  joins = "",
): PayloadCursor | null {
  const row = database
    .prepare(
      `SELECT e.id, e.occurred_at, e.event_id
       FROM events AS e ${joins}
       WHERE ${predicate}
       ORDER BY e.occurred_at DESC, e.event_id DESC, e.id DESC
       LIMIT 1`,
    )
    .get(...parameters) as
    | { id: number; occurred_at: string; event_id: string }
    | undefined;
  return row === undefined
    ? null
    : { occurredAt: row.occurred_at, eventId: row.event_id, id: row.id };
}

function sendAbortable(
  request: import("node:http").IncomingMessage,
  reply: FastifyReply,
  stream: Readable,
) {
  const abort = (): void => {
    stream.destroy();
  };
  request.once("aborted", abort);
  reply.raw.once("close", abort);
  stream.once("close", () => {
    request.off("aborted", abort);
    reply.raw.off("close", abort);
  });
  return reply.send(stream);
}

function boundedBatchSize(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) {
    throw new TypeError("export batch size must be between 1 and 100");
  }
  return value;
}

function safeFilename(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9_-]/gu, "_").slice(0, 128);
}

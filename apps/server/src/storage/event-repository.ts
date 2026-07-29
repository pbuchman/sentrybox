import { gzipSync, gunzipSync } from "node:zlib";
import type { FingerprintResult } from "@sentrybox/domain";
import type { NormalizedEvent } from "@sentrybox/protocol";
import type { ErrorHubDatabase } from "./database.js";

export interface EncodedNormalizedPayload {
  readonly json: string;
  readonly gzip: Buffer;
}

export interface EventInsert {
  readonly projectId: number;
  readonly issueId: number;
  readonly issueGeneration: number;
  readonly event: NormalizedEvent;
  readonly fingerprint: FingerprintResult;
}

export interface StoredEvent {
  readonly rowId: number;
  readonly eventId: string;
  readonly issueId: number;
  readonly projectId: number;
  readonly issueGeneration: number;
  readonly environment: string;
  readonly release: string | null;
  readonly service: string | null;
  readonly level: NormalizedEvent["level"];
  readonly platform: string | null;
  readonly title: string;
  readonly message: string | null;
  readonly exceptionType: string | null;
  readonly culprit: string | null;
  readonly occurredAt: string;
  readonly receivedAt: string;
  readonly requestId: string | null;
  readonly traceId: string | null;
  readonly taskId: string | null;
  readonly fingerprintVersion: number;
  readonly fingerprint: string;
  readonly payloadBytes: number;
  readonly compressedPayloadBytes: number;
  readonly truncated: boolean;
  readonly payload: NormalizedEvent;
}

interface StoredEventRow {
  id: number;
  event_id: string;
  issue_id: number;
  project_id: number;
  issue_generation: number;
  environment: string;
  release: string | null;
  service: string | null;
  level: NormalizedEvent["level"];
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
  fingerprint_version: number;
  fingerprint: string;
  payload_gzip: Buffer;
  payload_bytes: number;
  compressed_payload_bytes: number;
  truncated: 0 | 1;
}

const EVENT_COLUMNS = `
  id, event_id, issue_id, project_id, issue_generation, environment, release,
  service, level, platform, title, message, exception_type, culprit,
  occurred_at, received_at, request_id, trace_id, task_id,
  fingerprint_version, fingerprint, payload_gzip, payload_bytes,
  compressed_payload_bytes, truncated
`;

export class EventRepository {
  public constructor(private readonly database: ErrorHubDatabase) {}

  public insert(input: EventInsert): number {
    const eventId = requireNonEmpty(input.event.id, "event id");
    const environment = requireNonEmpty(
      input.event.environment,
      "event environment",
    );
    const payload = encodeNormalizedPayload(input.event);
    const result = this.database
      .prepare(
        `INSERT INTO events (
           event_id, issue_id, project_id, issue_generation, environment,
           release, service, level, platform, title, message, exception_type,
           culprit, occurred_at, received_at, request_id, trace_id, task_id,
           fingerprint_version, fingerprint, payload_gzip, payload_bytes,
           compressed_payload_bytes, truncated
         ) VALUES (
           ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         )`,
      )
      .run(
        eventId,
        input.issueId,
        input.projectId,
        input.issueGeneration,
        environment,
        input.event.release,
        input.event.serverName,
        input.event.level,
        input.event.platform,
        input.event.title,
        input.event.message,
        input.event.exception?.type ?? null,
        eventCulprit(input.event),
        input.event.occurredAt,
        input.event.receivedAt,
        input.event.requestId,
        input.event.traceId,
        input.event.taskId,
        input.fingerprint.version,
        input.fingerprint.digest,
        payload.gzip,
        Buffer.byteLength(payload.json, "utf8"),
        payload.gzip.byteLength,
        input.event.truncated ? 1 : 0,
      );
    const rowId = safeInteger(result.lastInsertRowid, "event row id");

    const insertTag = this.database.prepare(
      "INSERT INTO event_tags (event_row_id, tag_key, tag_value) VALUES (?, ?, ?)",
    );
    const tags = Object.entries(input.event.tags).sort(([left], [right]) =>
      compareCodePoints(left, right),
    );
    for (const [key, value] of tags) {
      insertTag.run(rowId, key, value);
    }
    return rowId;
  }

  public getByRowId(rowId: number): StoredEvent | null {
    const row = this.database
      .prepare(`SELECT ${EVENT_COLUMNS} FROM events WHERE id = ?`)
      .get(rowId) as StoredEventRow | undefined;
    return row === undefined ? null : mapStoredEvent(row);
  }

  public getByProjectAndEventId(
    projectId: number,
    eventId: string,
  ): StoredEvent | null {
    const row = this.database
      .prepare(
        `SELECT ${EVENT_COLUMNS}
         FROM events
         WHERE project_id = ? AND event_id = ?`,
      )
      .get(projectId, eventId) as StoredEventRow | undefined;
    return row === undefined ? null : mapStoredEvent(row);
  }

  public countByIssue(issueId: number): number {
    const row = this.database
      .prepare("SELECT COUNT(*) AS count FROM events WHERE issue_id = ?")
      .get(issueId) as { count: number };
    return row.count;
  }
}

export function encodeNormalizedPayload(
  event: NormalizedEvent,
): EncodedNormalizedPayload {
  const json = deterministicJson(event);
  return {
    json,
    gzip: gzipSync(Buffer.from(json, "utf8"), { level: 9 }),
  };
}

export function decodeNormalizedPayload(payload: Uint8Array): NormalizedEvent {
  const parsed: unknown = JSON.parse(gunzipSync(payload).toString("utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("stored normalized payload is not an object");
  }
  return parsed as NormalizedEvent;
}

function mapStoredEvent(row: StoredEventRow): StoredEvent {
  return {
    rowId: row.id,
    eventId: row.event_id,
    issueId: row.issue_id,
    projectId: row.project_id,
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
    fingerprintVersion: row.fingerprint_version,
    fingerprint: row.fingerprint,
    payloadBytes: row.payload_bytes,
    compressedPayloadBytes: row.compressed_payload_bytes,
    truncated: row.truncated === 1,
    payload: decodeNormalizedPayload(row.payload_gzip),
  };
}

function deterministicJson(value: unknown): string {
  const ancestors = new Set<object>();
  const serialize = (entry: unknown, inArray: boolean): string | undefined => {
    if (entry === null) return "null";
    switch (typeof entry) {
      case "string":
      case "boolean":
        return JSON.stringify(entry);
      case "number":
        return Number.isFinite(entry) ? JSON.stringify(entry) : "null";
      case "undefined":
      case "function":
      case "symbol":
        return inArray ? "null" : undefined;
      case "bigint":
        throw new TypeError("normalized payload cannot contain bigint");
      case "object": {
        if (ancestors.has(entry)) {
          throw new TypeError("normalized payload cannot contain cycles");
        }
        ancestors.add(entry);
        try {
          if (Array.isArray(entry)) {
            return `[${entry
              .map((item) => serialize(item, true) ?? "null")
              .join(",")}]`;
          }
          const record = entry as Record<string, unknown>;
          const properties: string[] = [];
          for (const key of Object.keys(record).sort(compareCodePoints)) {
            const serialized = serialize(record[key], false);
            if (serialized !== undefined) {
              properties.push(`${JSON.stringify(key)}:${serialized}`);
            }
          }
          return `{${properties.join(",")}}`;
        } finally {
          ancestors.delete(entry);
        }
      }
    }
  };
  return serialize(value, false) ?? "null";
}

function eventCulprit(event: NormalizedEvent): string | null {
  const frames = event.exception?.frames ?? [];
  for (let index = frames.length - 1; index >= 0; index -= 1) {
    const frame = frames[index];
    if (frame?.in_app !== true) continue;
    for (const key of ["module", "function", "filename"] as const) {
      const value = frame[key];
      if (typeof value === "string" && value.length > 0) return value;
    }
  }
  return null;
}

function requireNonEmpty(value: string | null, field: string): string {
  if (value === null || value.length === 0) {
    throw new TypeError(`${field} must not be empty`);
  }
  return value;
}

function safeInteger(value: number | bigint, field: string): number {
  const converted = typeof value === "bigint" ? Number(value) : value;
  if (!Number.isSafeInteger(converted) || converted <= 0) {
    throw new RangeError(`${field} must be a positive safe integer`);
  }
  return converted;
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

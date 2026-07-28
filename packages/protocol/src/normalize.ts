import {
  byteLength,
  MAX_BREADCRUMBS,
  MAX_EXCEPTION_FRAMES,
  MAX_MESSAGE_BYTES,
  MAX_NORMALIZED_EVENT_BYTES,
  MAX_TAG_KEY_BYTES,
  MAX_TAGS,
  MAX_TAG_VALUE_BYTES,
  MAX_TITLE_BYTES,
  truncateUtf8,
} from "./limits.js";
import { redactString, redactValue } from "./redact.js";

export type ErrorLevel = "warn" | "error" | "fatal";

export type Admission =
  | { readonly accepted: true; readonly level: ErrorLevel }
  | {
      readonly accepted: false;
      readonly reason: "below_threshold" | "unsupported_item";
    };

export interface NormalizedEventInput {
  readonly event_id?: unknown;
  readonly timestamp?: unknown;
  readonly level?: unknown;
  readonly title?: unknown;
  readonly message?: unknown;
  readonly exception?: unknown;
  readonly breadcrumbs?: unknown;
  readonly tags?: unknown;
  readonly contexts?: unknown;
  readonly extra?: unknown;
  readonly release?: unknown;
  readonly environment?: unknown;
  readonly server_name?: unknown;
  readonly platform?: unknown;
  readonly logger?: unknown;
  readonly [key: string]: unknown;
}

export interface NormalizedException {
  readonly type: string | null;
  readonly value: string | null;
  readonly mechanism: unknown;
  readonly frames: readonly unknown[];
}

export interface NormalizedEvent {
  readonly id: string | null;
  readonly occurredAt: string;
  readonly receivedAt: string;
  readonly level: ErrorLevel;
  readonly title: string;
  readonly message: string | null;
  readonly exception: NormalizedException | null;
  readonly breadcrumbs: readonly unknown[];
  readonly tags: Readonly<Record<string, string>>;
  readonly contexts: unknown;
  readonly extras: unknown;
  readonly release: string | null;
  readonly environment: string | null;
  readonly serverName: string | null;
  readonly platform: string | null;
  readonly logger: string | null;
  readonly requestId: string | null;
  readonly traceId: string | null;
  readonly taskId: string | null;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly payloadBytes: number;
  readonly truncated: boolean;
  readonly truncationReasons: readonly string[];
}

export type NormalizationResult =
  | {
      readonly accepted: false;
      readonly reason: Extract<
        Admission,
        { readonly accepted: false }
      >["reason"];
    }
  | { readonly accepted: true; readonly event: NormalizedEvent };

export function admitEvent(input: NormalizedEventInput): Admission {
  switch (input.level) {
    case "warning":
    case "warn":
      return { accepted: true, level: "warn" };
    case "error":
      return { accepted: true, level: "error" };
    case "fatal":
      return { accepted: true, level: "fatal" };
    case undefined:
    case null:
      return hasNonEmptyException(input.exception)
        ? { accepted: true, level: "error" }
        : { accepted: false, reason: "below_threshold" };
    default:
      return { accepted: false, reason: "below_threshold" };
  }
}

export function normalizeEvent(
  input: NormalizedEventInput,
  receivedAt: string,
): NormalizationResult {
  const admission = admitEvent(input);
  if (!admission.accepted) {
    return admission;
  }

  const reasons = new Set<string>();
  const rawTags = asRecord(input.tags);
  const rawExtras = asRecord(input.extra);
  const rawContexts = asRecord(input.contexts);
  const message = readMessage(input.message);
  const normalizedException = normalizeException(input.exception, reasons);
  const title = bounded(
    redactOptionalString(input.title) ??
      message ??
      normalizedException?.value ??
      normalizedException?.type ??
      "",
    MAX_TITLE_BYTES,
    "title_bytes",
    reasons,
  );
  const normalizedMessage =
    message === null
      ? null
      : bounded(message, MAX_MESSAGE_BYTES, "message_bytes", reasons);
  const tags = normalizeTags(rawTags, reasons);
  const breadcrumbs = normalizeCollection(
    input.breadcrumbs,
    MAX_BREADCRUMBS,
    "breadcrumbs",
    reasons,
  );
  const contexts = redactValue(sanitizeContexts(rawContexts));
  const extras = redactValue(rawExtras);
  const correlations = extractCorrelations(rawTags, rawExtras, rawContexts);
  const payload = {
    contexts,
    extras,
    correlations: correlationEvidence(correlations),
  };

  const event: MutableNormalizedEvent = {
    id: boundedOptional(
      redactOptionalString(input.event_id),
      MAX_TAG_VALUE_BYTES,
      "event_id_bytes",
      reasons,
    ),
    occurredAt: bounded(
      redactOptionalString(input.timestamp) ?? redactString(receivedAt),
      MAX_TAG_VALUE_BYTES,
      "timestamp_bytes",
      reasons,
    ),
    receivedAt: bounded(
      redactString(receivedAt),
      MAX_TAG_VALUE_BYTES,
      "received_at_bytes",
      reasons,
    ),
    level: admission.level,
    title,
    message: normalizedMessage,
    exception: normalizedException,
    breadcrumbs,
    tags,
    contexts,
    extras,
    release: boundedOptional(
      redactOptionalString(input.release),
      MAX_TAG_VALUE_BYTES,
      "metadata_bytes",
      reasons,
    ),
    environment: boundedOptional(
      redactOptionalString(input.environment),
      MAX_TAG_VALUE_BYTES,
      "metadata_bytes",
      reasons,
    ),
    serverName: boundedOptional(
      redactOptionalString(input.server_name),
      MAX_TAG_VALUE_BYTES,
      "metadata_bytes",
      reasons,
    ),
    platform: boundedOptional(
      redactOptionalString(input.platform),
      MAX_TAG_VALUE_BYTES,
      "metadata_bytes",
      reasons,
    ),
    logger: boundedOptional(
      redactOptionalString(input.logger),
      MAX_TAG_VALUE_BYTES,
      "metadata_bytes",
      reasons,
    ),
    requestId: correlations.requestId.value,
    traceId: correlations.traceId.value,
    taskId: correlations.taskId.value,
    payload,
    payloadBytes: 0,
    truncated: false,
    truncationReasons: [],
  };

  enforceNormalizedEventLimit(event, reasons);
  return { accepted: true, event };
}

function normalizeException(
  value: unknown,
  reasons: Set<string>,
): NormalizedException | null {
  const exception = asRecord(value);
  const values = Array.isArray(exception.values) ? exception.values : [];
  const first = asRecord(values[0]);
  if (values.length === 0 || Object.keys(first).length === 0) {
    return null;
  }

  const stacktrace = asRecord(first.stacktrace);
  const frames = normalizeCollection(
    stacktrace.frames,
    MAX_EXCEPTION_FRAMES,
    "exception_frames",
    reasons,
  );
  return {
    type: boundedOptional(
      redactOptionalString(first.type),
      MAX_MESSAGE_BYTES,
      "exception_type_bytes",
      reasons,
    ),
    value: boundedOptional(
      redactOptionalString(first.value),
      MAX_MESSAGE_BYTES,
      "exception_value_bytes",
      reasons,
    ),
    mechanism: redactValue(first.mechanism),
    frames,
  };
}

function normalizeCollection(
  value: unknown,
  limit: number,
  reason: string,
  reasons: Set<string>,
): readonly unknown[] {
  if (!Array.isArray(value)) {
    return [];
  }
  if (value.length > limit) {
    reasons.add(reason);
  }
  return value.slice(0, limit).map((entry) => redactValue(entry));
}

function normalizeTags(
  value: Readonly<Record<string, unknown>>,
  reasons: Set<string>,
): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  const entries = Object.entries(value).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  if (entries.length > MAX_TAGS) {
    reasons.add("tags");
  }

  for (const [key, rawValue] of entries.slice(0, MAX_TAGS)) {
    if (key === "contentPreview") {
      reasons.add("tags");
      continue;
    }
    const boundedKey = bounded(key, MAX_TAG_KEY_BYTES, "tags", reasons);
    const redacted = redactValue({ [boundedKey]: readString(rawValue) ?? "" });
    const sanitized = asRecord(redacted)[boundedKey];
    if (typeof sanitized !== "string") {
      continue;
    }
    result[boundedKey] = bounded(
      sanitized,
      MAX_TAG_VALUE_BYTES,
      "tags",
      reasons,
    );
  }
  return result;
}

function extractCorrelations(
  tags: Readonly<Record<string, unknown>>,
  extras: Readonly<Record<string, unknown>>,
  contexts: Readonly<Record<string, unknown>>,
): Record<"requestId" | "traceId" | "taskId", CorrelationSelection> {
  return {
    requestId: findCorrelation(
      [
        { source: "tags", value: tags },
        { source: "extras", value: extras },
        { source: "contexts", value: contexts },
      ],
      ["requestId", "request_id", "reqId", "req_id"],
      ["request", "correlation"],
    ),
    traceId: findCorrelation(
      [
        { source: "tags", value: tags },
        { source: "extras", value: extras },
        { source: "contexts", value: contexts },
      ],
      ["traceId", "trace_id"],
      ["trace", "correlation"],
    ),
    taskId: findCorrelation(
      [
        { source: "tags", value: tags },
        { source: "extras", value: extras },
        { source: "contexts", value: contexts },
      ],
      ["taskId", "task_id"],
      ["task", "correlation"],
    ),
  };
}

function findCorrelation(
  sources: readonly {
    readonly source: CorrelationSelection["source"];
    readonly value: Readonly<Record<string, unknown>>;
  }[],
  aliases: readonly string[],
  contextNames: readonly string[],
): CorrelationSelection {
  for (const source of sources) {
    const direct = readAliases(source.value, aliases);
    if (direct !== null) {
      return { source: source.source, ...direct };
    }
    if (source.source !== "contexts") {
      continue;
    }
    for (const contextName of contextNames) {
      const nested = readAliases(asRecord(source.value[contextName]), aliases);
      if (nested !== null) {
        return { source: source.source, ...nested };
      }
    }
  }
  return { source: null, alias: null, value: null };
}

function readAliases(
  source: Readonly<Record<string, unknown>>,
  aliases: readonly string[],
): Pick<CorrelationSelection, "alias" | "value"> | null {
  for (const alias of aliases) {
    const value = readString(source[alias]);
    if (value === null || redactString(value) !== value) {
      continue;
    }
    return { alias, value };
  }
  return null;
}

function correlationEvidence(
  correlations: Record<
    "requestId" | "traceId" | "taskId",
    CorrelationSelection
  >,
): Readonly<
  Record<string, Pick<CorrelationSelection, "alias" | "source" | "value">>
> {
  return Object.fromEntries(
    Object.entries(correlations)
      .filter(([, selection]) => selection.value !== null)
      .map(([name, selection]) => [name, selection]),
  );
}

function sanitizeContexts(value: unknown): unknown {
  const contexts = asRecord(value);
  const request = asRecord(contexts.request);
  const headers = asRecord(request.headers);
  if (Object.keys(request).length === 0) {
    return contexts;
  }

  const allowedHeaders = new Set([
    "content-type",
    "host",
    "method",
    "request-id",
    "traceparent",
    "tracestate",
    "user-agent",
    "x-request-id",
  ]);
  const safeHeaders = Object.fromEntries(
    Object.entries(headers).filter(([key]) =>
      allowedHeaders.has(key.toLowerCase()),
    ),
  );
  const url = readString(request.url);
  return {
    ...contexts,
    request: {
      ...request,
      ...(url === null ? {} : { url: sanitizeRequestUrl(url) }),
      headers: safeHeaders,
    },
  };
}

function sanitizeRequestUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    for (const [key, parameterValue] of url.searchParams) {
      if (isSensitiveUrlParameter(key)) {
        url.searchParams.set(key, "[REDACTED]");
      } else {
        url.searchParams.set(key, redactString(parameterValue));
      }
    }
    return url.toString();
  } catch {
    return redactString(value);
  }
}

function isSensitiveUrlParameter(key: string): boolean {
  return /(?:authorization|credential|secret|password|token|api[_-]?key|access[_-]?key)/i.test(
    key,
  );
}

function enforceNormalizedEventLimit(
  event: MutableNormalizedEvent,
  reasons: Set<string>,
): void {
  const maxBytes = MAX_NORMALIZED_EVENT_BYTES - 1024;
  refreshMetadata(event, reasons);
  if (byteLength(JSON.stringify(event)) <= maxBytes) {
    return;
  }

  reasons.add("normalized_json");
  event.payload = { contexts: {}, extras: {} };
  event.contexts = {};
  event.extras = {};
  refreshMetadata(event, reasons);
  if (byteLength(JSON.stringify(event)) <= maxBytes) {
    return;
  }

  event.breadcrumbs = [];
  event.exception =
    event.exception === null ? null : { ...event.exception, frames: [] };
  event.tags = {};
  refreshMetadata(event, reasons);
}

function refreshMetadata(
  event: MutableNormalizedEvent,
  reasons: Set<string>,
): void {
  event.truncated = reasons.size > 0;
  event.truncationReasons = [...reasons];
  event.payloadBytes = byteLength(JSON.stringify(event.payload));
}

function hasNonEmptyException(value: unknown): boolean {
  const exception = asRecord(value);
  return (
    Array.isArray(exception.values) &&
    exception.values.some((entry) => Object.keys(asRecord(entry)).length > 0)
  );
}

function readMessage(value: unknown): string | null {
  if (typeof value === "string") {
    return redactString(value);
  }
  const message = asRecord(value);
  return (
    redactOptionalString(message.formatted) ??
    redactOptionalString(message.message)
  );
}

function readString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function redactOptionalString(value: unknown): string | null {
  const string = readString(value);
  return string === null ? null : redactString(string);
}

function bounded(
  value: string,
  limit: number,
  reason: string,
  reasons: Set<string>,
): string {
  const truncated = truncateUtf8(value, limit);
  if (truncated !== value) {
    reasons.add(reason);
  }
  return truncated;
}

function boundedOptional(
  value: string | null,
  limit: number,
  reason: string,
  reasons: Set<string>,
): string | null {
  return value === null ? null : bounded(value, limit, reason, reasons);
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

interface MutableNormalizedEvent {
  id: string | null;
  occurredAt: string;
  receivedAt: string;
  level: ErrorLevel;
  title: string;
  message: string | null;
  exception: NormalizedException | null;
  breadcrumbs: readonly unknown[];
  tags: Readonly<Record<string, string>>;
  contexts: unknown;
  extras: unknown;
  release: string | null;
  environment: string | null;
  serverName: string | null;
  platform: string | null;
  logger: string | null;
  requestId: string | null;
  traceId: string | null;
  taskId: string | null;
  payload: Readonly<Record<string, unknown>>;
  payloadBytes: number;
  truncated: boolean;
  truncationReasons: readonly string[];
}

interface CorrelationSelection {
  readonly source: "tags" | "extras" | "contexts" | null;
  readonly alias: string | null;
  readonly value: string | null;
}

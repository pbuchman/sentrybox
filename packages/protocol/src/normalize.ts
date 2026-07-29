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
import { isSensitiveKey, redactString, redactWithMetadata } from "./redact.js";

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
  readonly mechanism: Readonly<Record<string, unknown>>;
  readonly frames: readonly Readonly<Record<string, unknown>>[];
  readonly discardedValues: number;
}

export interface NormalizedEvent {
  readonly id: string | null;
  readonly occurredAt: string;
  readonly receivedAt: string;
  readonly level: ErrorLevel;
  readonly title: string;
  readonly message: string | null;
  readonly exception: NormalizedException | null;
  readonly breadcrumbs: readonly Readonly<Record<string, unknown>>[];
  readonly tags: Readonly<Record<string, string>>;
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

const MAX_DIAGNOSTIC_STRING_BYTES = MAX_TAG_VALUE_BYTES;
const DUMMY_URL_ORIGIN = "https://sentrybox.invalid";
const REQUEST_HEADERS = new Set([
  "content-type",
  "host",
  "method",
  "request-id",
  "traceparent",
  "tracestate",
  "user-agent",
  "x-request-id",
]);
const EXTRA_KEYS = new Set([
  "code",
  "errorCode",
  "error_code",
  "logger",
  "operation",
  "requestId",
  "request_id",
  "reqId",
  "req_id",
  "service",
  "sessionId",
  "session_id",
  "statusCode",
  "status_code",
  "taskId",
  "task_id",
  "traceId",
  "trace_id",
  "userId",
  "user_id",
]);

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
  const tags = normalizeTags(asRecord(input.tags), reasons);
  const exception = normalizeException(input.exception, reasons);
  const message = normalizeMessage(input.message, reasons);
  const title = bounded(
    normalizedString(input.title, MAX_TITLE_BYTES, "title_bytes", reasons) ??
      message ??
      exception?.value ??
      exception?.type ??
      "",
    MAX_TITLE_BYTES,
    "title_bytes",
    reasons,
  );
  const breadcrumbs = normalizeBreadcrumbs(input.breadcrumbs, reasons);
  const contexts = normalizeContexts(input.contexts, reasons);
  const extras = normalizeExtras(input.extra, reasons);
  const correlations = extractCorrelations(
    asRecord(input.tags),
    asRecord(input.extra),
    asRecord(input.contexts),
    reasons,
  );

  const event: MutableNormalizedEvent = {
    id: normalizedString(
      input.event_id,
      MAX_TAG_VALUE_BYTES,
      "event_id_bytes",
      reasons,
    ),
    occurredAt:
      normalizedString(
        input.timestamp,
        MAX_TAG_VALUE_BYTES,
        "timestamp_bytes",
        reasons,
      ) ??
      bounded(
        redactString(receivedAt),
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
    message,
    exception,
    breadcrumbs,
    tags,
    release: normalizedString(
      input.release,
      MAX_TAG_VALUE_BYTES,
      "metadata_bytes",
      reasons,
    ),
    environment: normalizedString(
      input.environment,
      MAX_TAG_VALUE_BYTES,
      "metadata_bytes",
      reasons,
    ),
    serverName: normalizedString(
      input.server_name,
      MAX_TAG_VALUE_BYTES,
      "metadata_bytes",
      reasons,
    ),
    platform: normalizedString(
      input.platform,
      MAX_TAG_VALUE_BYTES,
      "metadata_bytes",
      reasons,
    ),
    logger: normalizedString(
      input.logger,
      MAX_TAG_VALUE_BYTES,
      "metadata_bytes",
      reasons,
    ),
    requestId: correlations.requestId.value,
    traceId: correlations.traceId.value,
    taskId: correlations.taskId.value,
    payload: {
      contexts,
      extras,
      correlations: correlationEvidence(correlations),
    },
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
  const exceptionValues = asRecord(value).values;
  const values: readonly unknown[] = Array.isArray(exceptionValues)
    ? exceptionValues
    : [];
  const selectedIndex = values.findIndex((entry) =>
    isMeaningfulException(entry),
  );
  if (selectedIndex === -1) {
    return null;
  }
  const selected = asRecord(values[selectedIndex]);
  const discardedValues = values
    .slice(selectedIndex + 1)
    .filter(isMeaningfulException).length;
  if (discardedValues > 0) {
    reasons.add("exception_chain");
  }
  const stacktrace = asRecord(selected.stacktrace);
  return {
    type: normalizedString(
      selected.type,
      MAX_MESSAGE_BYTES,
      "exception_type_bytes",
      reasons,
    ),
    value: normalizedString(
      selected.value,
      MAX_MESSAGE_BYTES,
      "exception_value_bytes",
      reasons,
    ),
    mechanism: pickDiagnosticScalars(
      asRecord(selected.mechanism),
      ["type", "handled", "synthetic"],
      reasons,
    ),
    frames: normalizeFrames(stacktrace.frames, reasons),
    discardedValues,
  };
}

function normalizeFrames(
  value: unknown,
  reasons: Set<string>,
): readonly Readonly<Record<string, unknown>>[] {
  if (!Array.isArray(value)) {
    return [];
  }
  if (value.length > MAX_EXCEPTION_FRAMES) {
    reasons.add("exception_frames");
  }
  return value.slice(0, MAX_EXCEPTION_FRAMES).map((frame) => {
    const redacted = redactRecord(frame, reasons);
    return pickDiagnosticScalars(
      redacted,
      [
        "abs_path",
        "colno",
        "filename",
        "function",
        "in_app",
        "lineno",
        "module",
        "package",
      ],
      reasons,
    );
  });
}

function normalizeBreadcrumbs(
  value: unknown,
  reasons: Set<string>,
): readonly Readonly<Record<string, unknown>>[] {
  if (!Array.isArray(value)) {
    return [];
  }
  if (value.length > MAX_BREADCRUMBS) {
    reasons.add("breadcrumbs");
  }
  return value
    .slice(0, MAX_BREADCRUMBS)
    .map((breadcrumb) =>
      pickDiagnosticScalars(
        redactRecord(breadcrumb, reasons),
        ["category", "level", "message", "timestamp", "type"],
        reasons,
      ),
    );
}

function normalizeContexts(
  value: unknown,
  reasons: Set<string>,
): Readonly<Record<string, unknown>> {
  const sanitized = sanitizeContexts(asRecord(value));
  const redacted = redactRecord(sanitized, reasons);
  const result = nullRecord();
  const request = asRecord(redacted.request);
  if (Object.keys(request).length > 0) {
    result.request = {
      ...pickDiagnosticScalars(request, ["method", "url"], reasons),
      headers: pickDiagnosticScalars(
        asRecord(request.headers),
        [...REQUEST_HEADERS],
        reasons,
      ),
    };
  }
  const runtime = pickDiagnosticScalars(
    asRecord(redacted.runtime),
    ["name", "version"],
    reasons,
  );
  if (Object.keys(runtime).length > 0) {
    result.runtime = runtime;
  }
  const trace = pickDiagnosticScalars(
    asRecord(redacted.trace),
    ["span_id", "status", "trace_id"],
    reasons,
  );
  if (Object.keys(trace).length > 0) {
    result.trace = trace;
  }
  return result;
}

function normalizeExtras(
  value: unknown,
  reasons: Set<string>,
): Readonly<Record<string, unknown>> {
  const redaction = redactWithMetadata(value);
  if (redaction.truncated) {
    reasons.add("recursion_depth");
  }
  const extras = asRecord(redaction.value);
  const result = nullRecord();
  for (const key of [...EXTRA_KEYS].sort(compareCodePoints)) {
    if (!(key in extras)) {
      continue;
    }
    const scalar = normalizeScalar(
      extras[key],
      MAX_DIAGNOSTIC_STRING_BYTES,
      "extras",
      reasons,
    );
    if (scalar !== undefined) {
      result[key] = scalar;
    }
  }
  if (redaction.truncated) {
    result.recursionTruncated = "[TRUNCATED: recursion_depth]";
  }
  return result;
}

function normalizeTags(
  value: Readonly<Record<string, unknown>>,
  reasons: Set<string>,
): Readonly<Record<string, string>> {
  const result = nullRecord() as Record<string, string>;
  const entries = Object.entries(value).sort(([left], [right]) =>
    compareCodePoints(left, right),
  );
  if (entries.length > MAX_TAGS) {
    reasons.add("tags");
  }
  for (const [key, rawValue] of entries) {
    if (Object.keys(result).length >= MAX_TAGS) {
      break;
    }
    if (key === "contentPreview") {
      reasons.add("tags");
      continue;
    }
    const boundedKey = bounded(key, MAX_TAG_KEY_BYTES, "tags", reasons);
    if (Object.hasOwn(result, boundedKey)) {
      reasons.add("tags");
      continue;
    }
    const raw = isSensitiveKey(key) ? "[REDACTED]" : rawValue;
    const value =
      normalizedString(raw, MAX_TAG_VALUE_BYTES, "tags", reasons) ?? "";
    result[boundedKey] = value;
  }
  return result;
}

function extractCorrelations(
  tags: Readonly<Record<string, unknown>>,
  extras: Readonly<Record<string, unknown>>,
  contexts: Readonly<Record<string, unknown>>,
  reasons: Set<string>,
): Record<"requestId" | "traceId" | "taskId", CorrelationSelection> {
  const sources = [
    { source: "tags" as const, value: tags },
    { source: "extras" as const, value: extras },
    { source: "contexts" as const, value: contexts },
  ];
  return {
    requestId: findCorrelation(
      sources,
      ["requestId", "request_id", "reqId", "req_id"],
      ["request", "correlation"],
      reasons,
    ),
    traceId: findCorrelation(
      sources,
      ["traceId", "trace_id"],
      ["trace", "correlation"],
      reasons,
    ),
    taskId: findCorrelation(
      sources,
      ["taskId", "task_id"],
      ["task", "correlation"],
      reasons,
    ),
  };
}

function findCorrelation(
  sources: readonly CorrelationSource[],
  aliases: readonly string[],
  contextNames: readonly string[],
  reasons: Set<string>,
): CorrelationSelection {
  for (const source of sources) {
    const direct = readAliases(source.value, aliases, reasons);
    if (direct !== null) {
      return { source: source.source, ...direct };
    }
    if (source.source === "contexts") {
      for (const contextName of contextNames) {
        const nested = readAliases(
          asRecord(source.value[contextName]),
          aliases,
          reasons,
        );
        if (nested !== null) {
          return { source: source.source, ...nested };
        }
      }
    }
  }
  return { source: null, alias: null, value: null };
}

function readAliases(
  source: Readonly<Record<string, unknown>>,
  aliases: readonly string[],
  reasons: Set<string>,
): Pick<CorrelationSelection, "alias" | "value"> | null {
  for (const alias of aliases) {
    const rawValue = source[alias];
    if (typeof rawValue !== "string" || redactString(rawValue) !== rawValue) {
      continue;
    }
    return {
      alias,
      value: bounded(
        rawValue,
        MAX_TAG_VALUE_BYTES,
        "correlation_bytes",
        reasons,
      ),
    };
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

function sanitizeContexts(
  contexts: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const request = asRecord(contexts.request);
  if (Object.keys(request).length === 0) {
    return contexts;
  }
  const headers = nullRecord();
  for (const [key, value] of Object.entries(asRecord(request.headers))) {
    const canonicalKey = key.toLowerCase();
    if (REQUEST_HEADERS.has(canonicalKey)) {
      headers[canonicalKey] = value;
    }
  }
  return {
    ...contexts,
    request: {
      method: request.method,
      url:
        typeof request.url === "string"
          ? sanitizeRequestUrl(request.url)
          : undefined,
      headers,
    },
  };
}

function sanitizeRequestUrl(value: string): string {
  try {
    const url = new URL(value, DUMMY_URL_ORIGIN);
    url.username = "";
    url.password = "";
    redactSearchParameters(url.searchParams);
    return url.origin === DUMMY_URL_ORIGIN
      ? `${url.pathname}${url.search}${url.hash}`
      : url.toString();
  } catch {
    return sanitizeMalformedUrl(value);
  }
}

function sanitizeMalformedUrl(value: string): string {
  const withoutUserInfo = value.replace(/(\/\/)[^/?#@]*@/u, "$1");
  const parts = withoutUserInfo.split("#", 2);
  const beforeHash = parts[0] ?? "";
  const hash = parts[1] ?? "";
  const questionMark = beforeHash.indexOf("?");
  if (questionMark === -1) {
    return redactString(withoutUserInfo);
  }
  const path = beforeHash.slice(0, questionMark);
  const query = beforeHash
    .slice(questionMark + 1)
    .split("&")
    .map((part) => {
      const equals = part.indexOf("=");
      const key = equals === -1 ? part : part.slice(0, equals);
      const rawValue = equals === -1 ? "" : part.slice(equals + 1);
      return isSensitiveUrlParameter(safeDecode(key))
        ? `${key}=%5BREDACTED%5D`
        : `${key}${equals === -1 ? "" : `=${redactString(rawValue)}`}`;
    });
  return `${path}?${query.join("&")}${hash === "" ? "" : `#${hash}`}`;
}

function redactSearchParameters(parameters: URLSearchParams): void {
  for (const [key, value] of parameters) {
    parameters.set(
      key,
      isSensitiveUrlParameter(key) ? "[REDACTED]" : redactString(value),
    );
  }
}

function isSensitiveUrlParameter(key: string): boolean {
  return isSensitiveKey(key);
}

function pickDiagnosticScalars(
  source: Readonly<Record<string, unknown>>,
  keys: readonly string[],
  reasons: Set<string>,
): Readonly<Record<string, unknown>> {
  const result = nullRecord();
  for (const key of keys) {
    const value = normalizeScalar(
      source[key],
      MAX_DIAGNOSTIC_STRING_BYTES,
      "diagnostic_bytes",
      reasons,
    );
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

function normalizeScalar(
  value: unknown,
  limit: number,
  reason: string,
  reasons: Set<string>,
): string | number | boolean | null | undefined {
  if (typeof value === "string") {
    return bounded(redactString(value), limit, reason, reasons);
  }
  return typeof value === "number" ||
    typeof value === "boolean" ||
    value === null
    ? value
    : undefined;
}

function redactRecord(
  value: unknown,
  reasons: Set<string>,
): Record<string, unknown> {
  const redaction = redactWithMetadata(value);
  if (redaction.truncated) {
    reasons.add("recursion_depth");
  }
  return asRecord(redaction.value);
}

function normalizedString(
  value: unknown,
  limit: number,
  reason: string,
  reasons: Set<string>,
): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const redaction = redactWithMetadata(value);
  if (redaction.truncated) {
    reasons.add("recursion_depth");
  }
  return bounded(String(redaction.value), limit, reason, reasons);
}

function normalizeMessage(value: unknown, reasons: Set<string>): string | null {
  if (typeof value === "string") {
    return normalizedString(value, MAX_MESSAGE_BYTES, "message_bytes", reasons);
  }
  const message = asRecord(value);
  return (
    normalizedString(
      message.formatted,
      MAX_MESSAGE_BYTES,
      "message_bytes",
      reasons,
    ) ??
    normalizedString(
      message.message,
      MAX_MESSAGE_BYTES,
      "message_bytes",
      reasons,
    )
  );
}

function enforceNormalizedEventLimit(
  event: MutableNormalizedEvent,
  reasons: Set<string>,
): void {
  const targetBytes = MAX_NORMALIZED_EVENT_BYTES - 1024;
  const compact = [
    () => {
      event.payload = { contexts: {}, extras: {}, correlations: {} };
    },
    () => {
      event.breadcrumbs = [];
      event.exception =
        event.exception === null ? null : { ...event.exception, frames: [] };
      event.tags = nullRecord() as Record<string, string>;
    },
    () => {
      event.requestId = null;
      event.traceId = null;
      event.taskId = null;
      event.id = null;
      event.message = null;
      event.title = truncateUtf8(event.title, 256);
      event.exception = null;
    },
  ];
  refreshMetadata(event, reasons);
  if (byteLength(JSON.stringify(event)) <= targetBytes) {
    return;
  }
  reasons.add("normalized_json");
  for (const reduce of compact) {
    reduce();
    refreshMetadata(event, reasons);
    if (byteLength(JSON.stringify(event)) <= targetBytes) {
      return;
    }
  }
  event.occurredAt = truncateUtf8(event.occurredAt, 64);
  event.receivedAt = truncateUtf8(event.receivedAt, 64);
  event.release = null;
  event.environment = null;
  event.serverName = null;
  event.platform = null;
  event.logger = null;
  refreshMetadata(event, reasons);
  if (byteLength(JSON.stringify(event)) > targetBytes) {
    event.id = null;
    event.occurredAt = "";
    event.receivedAt = "";
    event.title = "";
    event.payload = nullRecord();
    refreshMetadata(event, reasons);
  }
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
  const exceptionValues = asRecord(value).values;
  return (
    Array.isArray(exceptionValues) &&
    exceptionValues.some(isMeaningfulException)
  );
}

function isMeaningfulException(value: unknown): boolean {
  return Object.keys(asRecord(value)).length > 0;
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

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : nullRecord();
}

function nullRecord(): Record<string, unknown> {
  return Object.create(null) as Record<string, unknown>;
}

function compareCodePoints(left: string, right: string): number {
  const leftPoints = [...left];
  const rightPoints = [...right];
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    const difference =
      leftPoints[index]!.codePointAt(0)! - rightPoints[index]!.codePointAt(0)!;
    if (difference !== 0) {
      return difference;
    }
  }
  return leftPoints.length - rightPoints.length;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

interface MutableNormalizedEvent {
  id: string | null;
  occurredAt: string;
  receivedAt: string;
  level: ErrorLevel;
  title: string;
  message: string | null;
  exception: NormalizedException | null;
  breadcrumbs: readonly Readonly<Record<string, unknown>>[];
  tags: Readonly<Record<string, string>>;
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

interface CorrelationSource {
  readonly source: Exclude<CorrelationSelection["source"], null>;
  readonly value: Readonly<Record<string, unknown>>;
}

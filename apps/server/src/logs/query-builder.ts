export type LogCorrelationConfidence =
  | "exact_identifier"
  | "time_message_fallback"
  | "not_applicable";

export type LogIdentifierKind = "traceId" | "requestId" | "taskId";

export interface LogLocatorEvent {
  readonly occurredAt: string;
  readonly environment: string;
  readonly service: string | null;
  readonly platform: string | null;
  readonly traceId: string | null;
  readonly requestId: string | null;
  readonly taskId: string | null;
  readonly message: string | null;
  readonly exceptionType: string | null;
  readonly title: string;
}

export interface LogLocatorOptions {
  readonly grafanaExploreUrl?: URL | null;
  readonly windowMs?: number;
}

export interface LogLocator {
  readonly confidence: LogCorrelationConfidence;
  readonly query: string | null;
  readonly grafanaUrl: string | null;
  readonly from: string;
  readonly to: string;
  readonly criteria: {
    readonly environment: string;
    readonly service: string | null;
    readonly identifier: {
      readonly kind: LogIdentifierKind;
      readonly value: string;
    } | null;
    readonly message: string | null;
  };
  readonly explanation: string;
}

const DEFAULT_WINDOW_MS = 120_000;

export function buildLogLocator(
  event: LogLocatorEvent,
  options: LogLocatorOptions = {},
): LogLocator {
  const occurredAt = Date.parse(event.occurredAt);
  if (!Number.isFinite(occurredAt)) {
    throw new TypeError("log locator occurrence timestamp must be valid");
  }
  const windowMs = positiveInteger(
    options.windowMs ?? DEFAULT_WINDOW_MS,
    "log locator window",
  );
  const from = new Date(occurredAt - windowMs).toISOString();
  const to = new Date(occurredAt + windowMs).toISOString();
  const identifier = firstIdentifier(event);
  const browserWithoutServerLocator =
    event.platform?.toLowerCase() === "javascript" &&
    event.service === null &&
    identifier === null;
  if (browserWithoutServerLocator) {
    return {
      confidence: "not_applicable",
      query: null,
      grafanaUrl: null,
      from,
      to,
      criteria: {
        environment: event.environment,
        service: null,
        identifier: null,
        message: null,
      },
      explanation:
        "Browser-only events without a server identifier are not expected in server logs.",
    };
  }

  const selector = labelSelector(event.environment, event.service);
  const message = identifier === null ? fallbackMessage(event) : null;
  const query =
    identifier === null
      ? `${selector} |~ "${escapeLogQlRegex(fallbackMessage(event))}"`
      : `${selector} | json | ${identifier.kind}="${escapeLogQlLiteral(identifier.value)}"`;
  const confidence: LogCorrelationConfidence =
    identifier === null ? "time_message_fallback" : "exact_identifier";
  return {
    confidence,
    query,
    grafanaUrl: grafanaUrl(options.grafanaExploreUrl ?? null, query, from, to),
    from,
    to,
    criteria: {
      environment: event.environment,
      service: event.service,
      identifier,
      message,
    },
    explanation:
      identifier === null
        ? "Searches the event time window using service, environment, and normalized message evidence."
        : `Searches the event time window using the ${identifier.kind} correlation identifier.`,
  };
}

function firstIdentifier(
  event: LogLocatorEvent,
): LogLocator["criteria"]["identifier"] {
  for (const [kind, value] of [
    ["traceId", event.traceId],
    ["requestId", event.requestId],
    ["taskId", event.taskId],
  ] as const) {
    if (value !== null && value.length > 0) return { kind, value };
  }
  return null;
}

function fallbackMessage(event: LogLocatorEvent): string {
  for (const value of [event.message, event.exceptionType, event.title]) {
    if (value !== null && value.length > 0) return value;
  }
  return "error";
}

function labelSelector(environment: string, service: string | null): string {
  const labels = [`environment="${escapeLogQlLiteral(environment)}"`];
  if (service !== null) {
    labels.push(`service="${escapeLogQlLiteral(service)}"`);
  }
  return `{${labels.join(",")}}`;
}

function escapeLogQlRegex(value: string): string {
  return escapeLogQlLiteral(value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"));
}

function escapeLogQlLiteral(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("\r", "\\r")
    .replaceAll("\n", "\\n")
    .replaceAll("\t", "\\t")
    .replaceAll("`", "\\u0060");
}

function grafanaUrl(
  base: URL | null,
  query: string,
  from: string,
  to: string,
): string | null {
  if (base === null) return null;
  const url = new URL(base.toString());
  url.searchParams.set("from", String(Date.parse(from)));
  url.searchParams.set("to", String(Date.parse(to)));
  url.searchParams.set("query", query);
  return url.toString();
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${field} must be a positive safe integer`);
  }
  return value;
}

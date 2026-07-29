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
  readonly correlationEvidence?: unknown;
  readonly message: string | null;
  readonly exceptionType: string | null;
  readonly title: string;
}

interface SelectedIdentifier {
  readonly kind: LogIdentifierKind;
  readonly alias: string;
  readonly value: string;
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
    event.platform?.toLowerCase() === "javascript" && identifier === null;
  if (browserWithoutServerLocator) {
    return {
      confidence: "not_applicable",
      query: null,
      grafanaUrl: null,
      from,
      to,
      criteria: {
        environment: event.environment,
        service: event.service,
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
      : `${selector} |~ "${identifierLineRegex(identifier)}"`;
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
      identifier:
        identifier === null
          ? null
          : { kind: identifier.kind, value: identifier.value },
      message,
    },
    explanation:
      identifier === null
        ? "Searches the event time window using service, environment, and normalized message evidence."
        : `Searches the event time window using the ${identifier.kind} correlation identifier.`,
  };
}

function firstIdentifier(event: LogLocatorEvent): SelectedIdentifier | null {
  if (event.correlationEvidence !== undefined) {
    const evidence = record(event.correlationEvidence);
    for (const [kind, aliases] of [
      ["requestId", ["requestId", "request_id", "reqId", "req_id"]],
      ["taskId", ["taskId", "task_id"]],
      ["traceId", ["traceId", "trace_id"]],
    ] as const) {
      const selected = record(evidence[kind]);
      const alias = selected["alias"];
      const value = selected["value"];
      if (
        selected["source"] === "extras" &&
        typeof alias === "string" &&
        aliases.some((candidate) => candidate === alias) &&
        typeof value === "string" &&
        value.length > 0 &&
        value === event[kind]
      ) {
        return { kind, alias, value };
      }
    }
    return null;
  }

  for (const [kind, value] of [
    ["requestId", event.requestId],
    ["taskId", event.taskId],
    ["traceId", event.traceId],
  ] as const) {
    if (value !== null && value.length > 0) {
      return { kind, alias: kind, value };
    }
  }
  return null;
}

function identifierLineRegex(identifier: SelectedIdentifier): string {
  const alias = escapeLogQlRegex(identifier.alias);
  const value = escapeLogQlRegex(identifier.value);
  const pm2 = `(^|[|[:space:]])${alias}=${value}([|[:space:]]|$)`;
  const json = escapeLogQlRegex(
    `${JSON.stringify(identifier.alias)}:${JSON.stringify(identifier.value)}`,
  );
  return `${pm2}|${json}`;
}

function fallbackMessage(event: LogLocatorEvent): string {
  for (const value of [event.message, event.title, event.exceptionType]) {
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
  let escaped = "";
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        escaped += value[index]! + value[index + 1]!;
        index += 1;
      } else {
        escaped += "\\uFFFD";
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      escaped += "\\uFFFD";
    } else if (code === 0x22) escaped += '\\"';
    else if (code === 0x5c) escaped += "\\\\";
    else if (code <= 0x1f || code === 0x7f) {
      escaped += `\\u${code.toString(16).toUpperCase().padStart(4, "0")}`;
    } else escaped += value[index];
  }
  return escaped;
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}

function grafanaUrl(
  base: URL | null,
  query: string,
  from: string,
  to: string,
): string | null {
  if (base === null) return null;
  const url = new URL(base.toString());
  const datasourceUid = url.searchParams.get("datasource");
  if (datasourceUid === null) return null;
  url.searchParams.delete("datasource");
  url.searchParams.set("schemaVersion", "1");
  url.searchParams.set(
    "panes",
    JSON.stringify({
      A: {
        datasource: datasourceUid,
        queries: [
          {
            refId: "A",
            expr: query,
            queryType: "range",
            editorMode: "code",
            datasource: { uid: datasourceUid, type: "loki" },
          },
        ],
        range: {
          from: String(Date.parse(from)),
          to: String(Date.parse(to)),
        },
      },
    }),
  );
  return url.toString();
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${field} must be a positive safe integer`);
  }
  return value;
}

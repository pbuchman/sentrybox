export type ErrorLevel = "warn" | "error" | "fatal";
export type IssueStatus = "unresolved" | "resolved";

export interface Project {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
}

export interface FacetValue {
  readonly value: string | null;
  readonly queryValue: string;
  readonly label: string | null;
  readonly count: number;
}

export interface IssueFacetValue extends FacetValue {
  readonly lastSeen: string;
}

export interface IssueListItem {
  readonly id: number;
  readonly project: Project;
  readonly title: string;
  readonly status: IssueStatus;
  readonly generation: number;
  readonly count: number;
  readonly occurrenceCount: number;
  readonly matchingCount: number;
  readonly firstSeen: string;
  readonly lastSeen: string;
  readonly lastReceivedAt: string;
  readonly highestLevel: ErrorLevel;
  readonly resolvedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface Facets {
  readonly project: readonly FacetValue[];
  readonly release: readonly FacetValue[];
  readonly environment: readonly FacetValue[];
  readonly service: readonly FacetValue[];
  readonly level: readonly FacetValue[];
  readonly status: readonly FacetValue[];
}

export interface IssueListResponse {
  readonly items: readonly IssueListItem[];
  readonly nextCursor: string | null;
  readonly facets: Facets;
}

export type DeliveryState =
  | "pending"
  | "retry"
  | "delivered"
  | "dead_letter"
  | "suppressed";

export interface WebhookRedrive {
  readonly id: number;
  readonly deliveryId: string;
  readonly originalOutboxId: number;
  readonly state: "pending" | "delivered" | "dead_letter";
  readonly attempts: number;
  readonly requestedAt: string;
  readonly attemptedAt: string | null;
  readonly lastError: string | null;
}

export interface WebhookDelivery {
  readonly id: number;
  readonly deliveryId: string;
  readonly generation: number;
  readonly cause: "created" | "regressed";
  readonly state: DeliveryState;
  readonly attempts: number;
  readonly nextAttempt: string | null;
  readonly lastError: string | null;
  readonly createdAt: string;
  readonly deliveredAt: string | null;
  readonly redrives: readonly WebhookRedrive[];
}

export interface IssueDetail extends Omit<
  IssueListItem,
  "matchingCount" | "project"
> {
  readonly project: Project;
  readonly facets: {
    readonly environment: readonly IssueFacetValue[];
    readonly release: readonly IssueFacetValue[];
    readonly service: readonly IssueFacetValue[];
    readonly level: readonly IssueFacetValue[];
  };
  readonly deliveries: readonly WebhookDelivery[];
}

export interface EventSummary {
  readonly id: string;
  readonly rowId: number;
  readonly issueId: number;
  readonly projectId: number;
  readonly projectSlug: string;
  readonly issueGeneration: number;
  readonly environment: string;
  readonly release: string | null;
  readonly service: string | null;
  readonly level: ErrorLevel;
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
  readonly truncated: boolean;
}

export interface EventListResponse {
  readonly items: readonly EventSummary[];
  readonly nextCursor: string | null;
}

export type LogCorrelationConfidence =
  | "exact_identifier"
  | "time_message_fallback"
  | "not_applicable";

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
      readonly kind: "traceId" | "requestId" | "taskId";
      readonly value: string;
    } | null;
    readonly message: string | null;
  };
  readonly explanation: string;
}

export interface NormalizedFrame {
  readonly filename?: unknown;
  readonly function?: unknown;
  readonly module?: unknown;
  readonly lineno?: unknown;
  readonly colno?: unknown;
  readonly in_app?: unknown;
  readonly [key: string]: unknown;
}

export interface NormalizedEvent {
  readonly id?: unknown;
  readonly occurredAt?: unknown;
  readonly receivedAt?: unknown;
  readonly level?: unknown;
  readonly title?: unknown;
  readonly message?: unknown;
  readonly exception?: {
    readonly type?: unknown;
    readonly value?: unknown;
    readonly mechanism?: unknown;
    readonly frames?: readonly NormalizedFrame[];
    readonly discardedValues?: unknown;
  } | null;
  readonly breadcrumbs?: readonly Readonly<Record<string, unknown>>[];
  readonly tags?: Readonly<Record<string, unknown>>;
  readonly release?: unknown;
  readonly environment?: unknown;
  readonly serverName?: unknown;
  readonly platform?: unknown;
  readonly logger?: unknown;
  readonly requestId?: unknown;
  readonly traceId?: unknown;
  readonly taskId?: unknown;
  readonly payload?: {
    readonly contexts?: unknown;
    readonly extras?: unknown;
    readonly [key: string]: unknown;
  };
  readonly payloadBytes?: unknown;
  readonly truncated?: unknown;
  readonly truncationReasons?: unknown;
  readonly [key: string]: unknown;
}

export interface EventDetail extends Omit<
  EventSummary,
  "id" | "rowId" | "projectSlug"
> {
  readonly id: number;
  readonly eventId: string;
  readonly logLocator: LogLocator;
  readonly normalized: NormalizedEvent;
}

export interface SystemStatus {
  readonly status: "ok" | "not_ready" | "critical";
  readonly storage: {
    readonly physicalBytes: number | null;
    readonly budgetBytes: number;
  };
  readonly ingest: { readonly accepting: boolean };
  readonly outbox: { readonly deadLetter: number };
}

export interface OperatorApi {
  listIssues(filters: URLSearchParams): Promise<IssueListResponse>;
  getFacets(filters: URLSearchParams): Promise<Facets>;
  getSystemStatus(): Promise<SystemStatus>;
  getIssue(id: number): Promise<IssueDetail>;
  listIssueEvents(id: number, cursor?: string): Promise<EventListResponse>;
  getEvent(rowId: number): Promise<EventDetail>;
  resolveIssue(id: number): Promise<IssueDetail>;
  reopenIssue(id: number): Promise<IssueDetail>;
  deleteIssue(id: number): Promise<void>;
  retryDelivery(id: number): Promise<WebhookRedrive>;
  eventDownloadUrl(rowId: number): string;
  issueDownloadUrl(id: number): string;
}

type Fetcher = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

const READ_OPTIONS: RequestInit = {
  headers: { Accept: "application/json" },
};
const JSON_MUTATION_OPTIONS: RequestInit = {
  method: "POST",
  headers: {
    Accept: "application/json",
    "Content-Type": "application/json",
  },
  body: "{}",
};

export function createApiClient(
  fetcher: Fetcher = globalThis.fetch.bind(globalThis),
): OperatorApi {
  return {
    async listIssues(filters) {
      const query = filters.toString();
      return requestJson<IssueListResponse>(
        fetcher,
        `/api/issues${query.length === 0 ? "" : `?${query}`}`,
        READ_OPTIONS,
      );
    },
    async getSystemStatus() {
      return requestJson<SystemStatus>(
        fetcher,
        "/api/system/status",
        READ_OPTIONS,
      );
    },
    async getFacets(filters) {
      const query = filters.toString();
      return requestJson<Facets>(
        fetcher,
        `/api/facets${query.length === 0 ? "" : `?${query}`}`,
        READ_OPTIONS,
      );
    },
    async getIssue(id) {
      return requestJson<IssueDetail>(
        fetcher,
        `/api/issues/${String(id)}`,
        READ_OPTIONS,
      );
    },
    async listIssueEvents(id, cursor) {
      const query =
        cursor === undefined
          ? ""
          : `?${new URLSearchParams({ cursor }).toString()}`;
      return requestJson<EventListResponse>(
        fetcher,
        `/api/issues/${String(id)}/events${query}`,
        READ_OPTIONS,
      );
    },
    async getEvent(rowId) {
      return requestJson<EventDetail>(
        fetcher,
        `/api/events/${String(rowId)}`,
        READ_OPTIONS,
      );
    },
    async resolveIssue(id) {
      return requestJson<IssueDetail>(
        fetcher,
        `/api/issues/${String(id)}/resolve`,
        JSON_MUTATION_OPTIONS,
      );
    },
    async reopenIssue(id) {
      return requestJson<IssueDetail>(
        fetcher,
        `/api/issues/${String(id)}/reopen`,
        JSON_MUTATION_OPTIONS,
      );
    },
    async deleteIssue(id) {
      await request(fetcher, `/api/issues/${String(id)}`, {
        method: "DELETE",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
      });
    },
    async retryDelivery(id) {
      return requestJson<WebhookRedrive>(
        fetcher,
        `/api/webhook-deliveries/${String(id)}/retry`,
        JSON_MUTATION_OPTIONS,
      );
    },
    eventDownloadUrl(rowId) {
      return `/api/events/${String(rowId)}/download`;
    },
    issueDownloadUrl(id) {
      return `/api/issues/${String(id)}/download`;
    },
  };
}

async function requestJson<Result>(
  fetcher: Fetcher,
  path: string,
  options: RequestInit,
): Promise<Result> {
  const response = await request(fetcher, path, options);
  return (await response.json()) as Result;
}

async function request(
  fetcher: Fetcher,
  path: string,
  options: RequestInit,
): Promise<Response> {
  const response = await fetcher(path, options);
  if (response.ok) return response;
  let message = `Request failed with status ${String(response.status)}`;
  try {
    const body = (await response.json()) as {
      readonly error?: { readonly message?: unknown };
    };
    if (typeof body.error?.message === "string") {
      message = body.error.message;
    }
  } catch {
    // Keep the bounded status message when an intermediary returns non-JSON.
  }
  throw new Error(message);
}

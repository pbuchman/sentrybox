import type {
  EventDetail,
  EventListResponse,
  Facets,
  IssueDetail,
  IssueListItem,
  IssueStatus,
  OperatorApi,
  Project,
  WebhookRedrive,
} from "./client.js";

const projects: readonly Project[] = [
  { id: "1", slug: "intexuraos", name: "IntexuraOS" },
  { id: "2", slug: "billing-portal", name: "Billing Portal" },
  { id: "3", slug: "website", name: "Website" },
];

const seedIssues: readonly IssueListItem[] = [
  makeIssue(
    41,
    0,
    "TypeError: Cannot read properties of undefined",
    "error",
    143,
    18,
  ),
  makeIssue(
    42,
    0,
    "TimeoutError: upstream request exceeded 10s",
    "fatal",
    38,
    38,
    22,
  ),
  makeIssue(
    43,
    0,
    "Message delivery returned an invalid response",
    "warn",
    12,
    12,
    79,
  ),
  makeIssue(
    44,
    0,
    "Authentication token is no longer valid",
    "error",
    7,
    7,
    150,
    "resolved",
  ),
  makeIssue(
    51,
    1,
    "Invoice export failed during PDF rendering",
    "error",
    24,
    24,
    11,
  ),
  makeIssue(52, 1, "Payment provider rate limit reached", "warn", 9, 9, 64),
  makeIssue(61, 2, "Failed to preload the product image", "warn", 17, 17, 7),
];

export function createFixtureApi(): OperatorApi {
  let issues = [...seedIssues];

  const detailFor = (id: number): IssueDetail => {
    const issue = requiredIssue(issues, id);
    return {
      ...issue,
      facets: {
        environment: [
          issueFacet("production", issue.occurrenceCount, issue.lastSeen),
        ],
        release: [
          issueFacet(releaseFor(issue), issue.occurrenceCount, issue.lastSeen),
        ],
        service: [
          issueFacet(serviceFor(issue), issue.occurrenceCount, issue.lastSeen),
        ],
        level: [
          issueFacet(issue.highestLevel, issue.occurrenceCount, issue.lastSeen),
        ],
      },
      deliveries:
        id === 42
          ? [
              {
                id: 7042,
                deliveryId: "fixture-delivery-42",
                generation: 1,
                cause: "created",
                state: "dead_letter",
                attempts: 3,
                nextAttempt: null,
                lastError: "Destination returned 503",
                createdAt: issue.createdAt,
                deliveredAt: null,
                redrives: [],
              },
            ]
          : [],
    };
  };

  return {
    async listIssues(filters) {
      const filtered = filterIssues(issues, filters);
      return { items: filtered, nextCursor: null, facets: facetsFor(filtered) };
    },
    async getFacets(filters) {
      const scoped = filters.has("project")
        ? filterIssues(issues, filters)
        : issues;
      return facetsFor(scoped);
    },
    async getSystemStatus() {
      return {
        status: "ok",
        storage: { physicalBytes: 1_932_735_283, budgetBytes: 5_368_709_120 },
        ingest: { accepting: true },
        outbox: { deadLetter: 0 },
      };
    },
    async getIssue(id) {
      return detailFor(id);
    },
    async listIssueEvents(id): Promise<EventListResponse> {
      requiredIssue(issues, id);
      return { items: occurrencesFor(id), nextCursor: null };
    },
    async getEvent(rowId) {
      const issueId = Math.floor(rowId / 10);
      return eventFor(detailFor(issueId), rowId);
    },
    async resolveIssue(id) {
      issues = updateStatus(issues, id, "resolved");
      return detailFor(id);
    },
    async reopenIssue(id) {
      issues = updateStatus(issues, id, "unresolved");
      return detailFor(id);
    },
    async deleteIssue(id) {
      requiredIssue(issues, id);
      issues = issues.filter((issue) => issue.id !== id);
    },
    async retryDelivery(id): Promise<WebhookRedrive> {
      return {
        id: id + 1,
        deliveryId: `fixture-redrive-${String(id)}`,
        originalOutboxId: id,
        state: "pending",
        attempts: 0,
        requestedAt: new Date().toISOString(),
        attemptedAt: null,
        lastError: null,
      };
    },
    eventDownloadUrl: (rowId) => `/api/events/${String(rowId)}/download`,
    issueDownloadUrl: (id) => `/api/issues/${String(id)}/download`,
  };
}

function makeIssue(
  id: number,
  projectIndex: number,
  title: string,
  highestLevel: IssueListItem["highestLevel"],
  occurrenceCount: number,
  matchingCount: number,
  minutesAgo = 2,
  status: IssueStatus = "unresolved",
): IssueListItem {
  const lastSeen = new Date(
    Date.UTC(2026, 6, 30, 11, 58) - minutesAgo * 60_000,
  ).toISOString();
  return {
    id,
    project: projects[projectIndex] ?? projects[0]!,
    title,
    status,
    generation: 1,
    count: occurrenceCount,
    occurrenceCount,
    matchingCount,
    firstSeen: new Date(Date.parse(lastSeen) - 3 * 86_400_000).toISOString(),
    lastSeen,
    lastReceivedAt: new Date(Date.parse(lastSeen) + 1_000).toISOString(),
    highestLevel,
    resolvedAt: status === "resolved" ? lastSeen : null,
    createdAt: new Date(Date.parse(lastSeen) - 3 * 86_400_000).toISOString(),
    updatedAt: lastSeen,
  };
}

function filterIssues(
  items: readonly IssueListItem[],
  filters: URLSearchParams,
) {
  const project = filters.get("project");
  const query = filters.get("query")?.toLocaleLowerCase();
  return items.filter((issue) => {
    if (project !== null && issue.project.slug !== project) return false;
    if (query !== undefined && !issue.title.toLocaleLowerCase().includes(query))
      return false;
    for (const status of filters.getAll("status")) {
      if (status !== issue.status) return false;
    }
    const levels = filters.getAll("level");
    if (levels.length > 0 && !levels.includes(issue.highestLevel)) return false;
    return true;
  });
}

function facetsFor(items: readonly IssueListItem[]): Facets {
  return {
    project: projects.map((project) =>
      facet(
        project.slug,
        project.name,
        items.filter((item) => item.project.slug === project.slug).length,
      ),
    ),
    release: aggregate(items, releaseFor),
    environment:
      items.length === 0
        ? []
        : [facet("production", "production", items.length)],
    service: aggregate(items, serviceFor),
    level: aggregate(items, (item) => item.highestLevel),
    status: aggregate(items, (item) => item.status),
  };
}

function aggregate(
  items: readonly IssueListItem[],
  valueFor: (item: IssueListItem) => string,
) {
  const counts = new Map<string, number>();
  for (const item of items)
    counts.set(valueFor(item), (counts.get(valueFor(item)) ?? 0) + 1);
  return [...counts].map(([value, count]) => facet(value, value, count));
}

function facet(value: string, label: string, count: number) {
  return { value, queryValue: value, label, count };
}

function issueFacet(value: string, count: number, lastSeen: string) {
  return { ...facet(value, value, count), lastSeen };
}

function releaseFor(issue: Pick<IssueListItem, "project" | "id">): string {
  return issue.project.slug === "website" ? "web-2026.07.30" : "2026.07.30-a";
}

function serviceFor(issue: Pick<IssueListItem, "project" | "id">): string {
  if (issue.project.slug === "billing-portal") return "billing-api";
  if (issue.project.slug === "website") return "web-app";
  return issue.id === 42 ? "gateway-service" : "whatsapp-service";
}

function occurrencesFor(issueId: number) {
  const issue = requiredIssue(seedIssues, issueId);
  return [0, 1, 2].map((offset) => ({
    id: `fixture-${String(issueId)}-${String(offset)}`,
    rowId: issueId * 10 + offset,
    issueId,
    projectId: Number(issue.project.id),
    projectSlug: issue.project.slug,
    issueGeneration: 1,
    environment: "production",
    release: releaseFor(issue),
    service: serviceFor(issue),
    level: issue.highestLevel,
    platform: "node",
    title: issue.title,
    message: "The operation did not complete successfully.",
    exceptionType: issue.title.split(":")[0] ?? "Error",
    culprit: "processRequest",
    occurredAt: new Date(
      Date.parse(issue.lastSeen) - offset * 25 * 60_000,
    ).toISOString(),
    receivedAt: issue.lastReceivedAt,
    requestId: `req-${String(issueId)}-${String(offset)}`,
    traceId: null,
    taskId: null,
    truncated: false,
  }));
}

function eventFor(issue: IssueDetail, rowId: number): EventDetail {
  const occurrence = occurrencesFor(issue.id).find(
    (item) => item.rowId === rowId,
  );
  if (occurrence === undefined) throw new Error("Fixture occurrence not found");
  const query = `{environment="production",service="${serviceFor(issue)}"} |= "${occurrence.requestId}"`;
  return {
    ...occurrence,
    id: rowId,
    eventId: occurrence.id,
    logLocator: {
      confidence: "exact_identifier",
      query,
      grafanaUrl: "https://grafana.example/explore",
      from: new Date(Date.parse(occurrence.occurredAt) - 120_000).toISOString(),
      to: new Date(Date.parse(occurrence.occurredAt) + 120_000).toISOString(),
      criteria: {
        environment: occurrence.environment,
        service: occurrence.service,
        identifier: { kind: "requestId", value: occurrence.requestId ?? "" },
        message: occurrence.message,
      },
      explanation:
        "Matches the request identifier within a four-minute log window.",
    },
    normalized: {
      id: occurrence.id,
      occurredAt: occurrence.occurredAt,
      receivedAt: occurrence.receivedAt,
      level: occurrence.level,
      title: occurrence.title,
      message: occurrence.message,
      exception: {
        type: occurrence.exceptionType,
        value: issue.title,
        mechanism: { handled: true },
        frames: [
          {
            filename: "node_modules/framework/router.js",
            function: "dispatch",
            lineno: 88,
            in_app: false,
          },
          {
            filename: "src/workflows/process-request.ts",
            function: "processRequest",
            lineno: 42,
            colno: 17,
            in_app: true,
          },
          {
            filename: "src/routes/webhook.ts",
            function: "handleWebhook",
            lineno: 119,
            colno: 9,
            in_app: true,
          },
        ],
      },
      breadcrumbs: Array.from({ length: 9 }, (_, index) => ({
        timestamp: new Date(
          Date.parse(occurrence.occurredAt) - (9 - index) * 5_000,
        ).toISOString(),
        category: index % 2 === 0 ? "request" : "app",
        message:
          index === 8
            ? "POST /webhooks/message"
            : `Processing step ${String(index + 1)}`,
      })),
      tags: { region: "home-dev", runtime: "node" },
      release: occurrence.release,
      environment: occurrence.environment,
      serverName: occurrence.service,
      platform: occurrence.platform,
      requestId: occurrence.requestId,
      payload: {
        contexts: { runtime: { name: "node", version: "22.23.2" } },
        extras: { operation: "process request", authorization: "[REDACTED]" },
      },
      payloadBytes: 2_048,
      truncated: false,
      truncationReasons: [],
    },
  };
}

function updateStatus(
  items: readonly IssueListItem[],
  id: number,
  status: IssueStatus,
) {
  requiredIssue(items, id);
  return items.map((issue) =>
    issue.id === id
      ? {
          ...issue,
          status,
          resolvedAt: status === "resolved" ? new Date().toISOString() : null,
        }
      : issue,
  );
}

function requiredIssue(items: readonly IssueListItem[], id: number) {
  const issue = items.find((item) => item.id === id);
  if (issue === undefined) throw new Error("Fixture issue not found");
  return issue;
}

import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  EventDetail,
  EventSummary,
  Facets,
  IssueDetail,
  OperatorApi,
} from "../api/client.js";
import { App } from "../app.js";

const occurredAt = "2026-07-29T11:58:00.000Z";
const project = { id: "1", slug: "intexuraos", name: "IntexuraOS" };
const issue: IssueDetail = {
  id: 41,
  project,
  title: "TypeError: Cannot read properties of undefined",
  status: "unresolved",
  generation: 1,
  count: 2,
  occurrenceCount: 2,
  firstSeen: "2026-07-29T08:00:00.000Z",
  lastSeen: occurredAt,
  lastReceivedAt: "2026-07-29T11:58:01.000Z",
  highestLevel: "error",
  resolvedAt: null,
  createdAt: "2026-07-29T08:00:01.000Z",
  updatedAt: "2026-07-29T11:58:01.000Z",
  facets: {
    environment: [issueFacet("prod")],
    release: [issueFacet("2026.07.29-a")],
    service: [issueFacet("gateway")],
    level: [issueFacet("error")],
  },
  deliveries: [
    {
      id: 77,
      deliveryId: "delivery-77",
      generation: 1,
      cause: "created",
      state: "dead_letter",
      attempts: 3,
      nextAttempt: null,
      lastError: "Destination returned 503",
      createdAt: "2026-07-29T08:00:01.000Z",
      deliveredAt: null,
      redrives: [],
    },
  ],
};

const latest = summary(501, "event-latest", occurredAt);
const older = summary(500, "event-older", "2026-07-29T11:30:00.000Z");
const latestEvent = detail(latest);
const olderEvent = detail(older);

const facets: Facets = {
  project: [
    {
      value: project.slug,
      queryValue: project.slug,
      label: project.name,
      count: 2,
    },
  ],
  release: [
    {
      value: "2026.07.29-a",
      queryValue: "2026.07.29-a",
      label: "2026.07.29-a",
      count: 2,
    },
  ],
  environment: [{ value: "prod", queryValue: "prod", label: "prod", count: 2 }],
  service: [
    { value: "gateway", queryValue: "gateway", label: "gateway", count: 2 },
  ],
  level: [{ value: "error", queryValue: "error", label: "error", count: 2 }],
  status: [
    {
      value: "unresolved",
      queryValue: "unresolved",
      label: "unresolved",
      count: 2,
    },
  ],
};

function makeApi(overrides: Partial<OperatorApi> = {}): OperatorApi {
  let current = issue;
  return {
    listIssues: vi.fn(),
    getFacets: vi.fn(async () => facets),
    getSystemStatus: vi.fn(async () => ({
      status: "ok" as const,
      storage: { physicalBytes: 10, budgetBytes: 100 },
      ingest: { accepting: true },
      outbox: { deadLetter: 0 },
    })),
    getIssue: vi.fn(async () => current),
    listIssueEvents: vi.fn(async () => ({
      items: [latest, older],
      nextCursor: null,
    })),
    getEvent: vi.fn(async (rowId) =>
      rowId === older.rowId ? olderEvent : latestEvent,
    ),
    resolveIssue: vi.fn(async () => {
      current = { ...current, status: "resolved", resolvedAt: occurredAt };
      return current;
    }),
    reopenIssue: vi.fn(async () => {
      current = { ...current, status: "unresolved", resolvedAt: null };
      return current;
    }),
    deleteIssue: vi.fn(async () => undefined),
    retryDelivery: vi.fn(async () => ({
      id: 88,
      deliveryId: "retry-88",
      originalOutboxId: 77,
      state: "pending" as const,
      attempts: 0,
      requestedAt: occurredAt,
      attemptedAt: null,
      lastError: null,
    })),
    eventDownloadUrl: (rowId) => `/api/events/${String(rowId)}/download`,
    issueDownloadUrl: (id) => `/api/issues/${String(id)}/download`,
    ...overrides,
  };
}

describe("project-scoped issue detail", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/?issue=41");
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("puts occurrences beside the selected evidence and keeps technical data secondary", async () => {
    const api = makeApi();
    render(<App api={api} />);

    expect(
      await screen.findByRole("heading", { name: issue.title }),
    ).not.toBeNull();
    expect(
      screen.getByRole("complementary", { name: "Occurrences" }),
    ).not.toBeNull();
    expect(screen.getByRole("heading", { name: "TypeError" })).not.toBeNull();
    expect(
      screen.getByRole("heading", { name: "Matching logs" }),
    ).not.toBeNull();
    expect(screen.getByRole("heading", { name: "Breadcrumbs" })).not.toBeNull();
    expect(screen.getByText("processRequest")).not.toBeNull();
    expect(screen.getByRole("link", { name: /Open logs/ })).not.toBeNull();
    expect(
      screen
        .getByText("Raw event data")
        .closest("details")
        ?.hasAttribute("open"),
    ).toBe(false);
    expect(api.getEvent).toHaveBeenCalledWith(501);
  });

  it("selects another occurrence without reloading the issue and updates its permalink", async () => {
    const api = makeApi();
    const user = userEvent.setup();
    render(<App api={api} />);
    await screen.findByRole("heading", { name: issue.title });
    const rail = screen.getByRole("complementary", { name: "Occurrences" });
    const occurrenceButtons = within(rail).getAllByRole("button");
    await user.click(occurrenceButtons[1]!);

    await waitFor(() =>
      expect(window.location.search).toBe("?issue=41&event=event-older"),
    );
    expect(api.getIssue).toHaveBeenCalledTimes(1);
    expect(api.getEvent).toHaveBeenLastCalledWith(500);
  });

  it("resolves, reopens, downloads, and confirms permanent deletion from a compact action menu", async () => {
    const api = makeApi();
    const user = userEvent.setup();
    render(<App api={api} />);
    await screen.findByRole("heading", { name: issue.title });

    await user.click(screen.getByRole("button", { name: "Resolve" }));
    expect(await screen.findByText("Issue resolved.")).not.toBeNull();
    await user.click(screen.getByRole("button", { name: "Reopen" }));
    expect(await screen.findByText("Issue reopened.")).not.toBeNull();
    await user.click(screen.getByLabelText("More issue actions"));
    expect(
      screen.getByRole("link", { name: "Download issue" }).getAttribute("href"),
    ).toBe("/api/issues/41/download");
    await user.click(
      screen.getByRole("button", { name: "Delete permanently" }),
    );
    const dialog = screen.getByRole("dialog", {
      name: "Delete issue permanently?",
    });
    expect(within(dialog).getByText(/no undo/i)).not.toBeNull();
    await user.click(
      within(dialog).getByRole("button", {
        name: "Delete 2 events permanently",
      }),
    );
    await waitFor(() => expect(window.location.pathname).toBe("/"));
    expect(new URLSearchParams(window.location.search).get("project")).toBe(
      "intexuraos",
    );
  });

  it("makes live local data explicitly read-only", async () => {
    const api = makeApi();
    const user = userEvent.setup();
    render(<App api={api} readOnly />);
    await screen.findByRole("heading", { name: issue.title });

    expect(
      screen.getByText(/destructive actions are disabled locally/i),
    ).not.toBeNull();
    expect(
      (screen.getByRole("button", { name: "Resolve" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    await user.click(screen.getByLabelText("More issue actions"));
    expect(
      (
        screen.getByRole("button", {
          name: "Delete permanently",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(api.resolveIssue).not.toHaveBeenCalled();
  });

  it("reveals extra breadcrumbs and raw data only when requested", async () => {
    const user = userEvent.setup();
    render(<App api={makeApi()} />);
    await screen.findByRole("heading", { name: issue.title });

    expect(screen.getAllByRole("listitem").length).toBeGreaterThan(5);
    await user.click(screen.getByRole("button", { name: /Show 2 more/ }));
    expect(screen.getByText("step-8")).not.toBeNull();
    const raw = screen.getByText("Raw event data").closest("details")!;
    await user.click(screen.getByText("Raw event data"));
    expect(raw.hasAttribute("open")).toBe(true);
    expect(
      within(raw).getByText(/Cannot read properties of undefined/),
    ).not.toBeNull();
  });

  it("keeps dead-letter delivery recovery visible but secondary", async () => {
    const api = makeApi();
    const user = userEvent.setup();
    render(<App api={api} />);
    await screen.findByRole("heading", { name: issue.title });

    await user.click(screen.getByText("Delivery"));
    expect(screen.getByText("Destination returned 503")).not.toBeNull();
    await user.click(screen.getByRole("button", { name: "Retry delivery" }));
    expect(await screen.findByText("Delivery retry queued.")).not.toBeNull();
  });

  it("explains missing retained evidence and missing permalinks", async () => {
    const { unmount } = render(
      <App
        api={makeApi({
          listIssueEvents: vi.fn(async () => ({ items: [], nextCursor: null })),
        })}
      />,
    );
    expect(await screen.findByText("No retained evidence")).not.toBeNull();
    unmount();

    window.history.replaceState({}, "", "/?issue=41&event=missing");
    render(<App api={makeApi()} />);
    expect(
      await screen.findByText("Occurrence no longer retained"),
    ).not.toBeNull();
  });

  it("names a core loading failure and recovers", async () => {
    const getIssue = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(issue);
    const user = userEvent.setup();
    render(<App api={makeApi({ getIssue })} />);
    expect(
      await screen.findByRole("heading", {
        name: "Issue details could not be loaded",
      }),
    ).not.toBeNull();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(
      await screen.findByRole("heading", { name: issue.title }),
    ).not.toBeNull();
  });
});

function issueFacet(value: string) {
  return {
    value,
    queryValue: value,
    label: value,
    count: 2,
    lastSeen: occurredAt,
  };
}

function summary(rowId: number, id: string, at: string): EventSummary {
  return {
    id,
    rowId,
    issueId: 41,
    projectId: 1,
    projectSlug: project.slug,
    issueGeneration: 1,
    environment: "prod",
    release: "2026.07.29-a",
    service: "gateway",
    level: "error",
    platform: "node",
    title: issue.title,
    message: "Cannot read value",
    exceptionType: "TypeError",
    culprit: "processRequest",
    occurredAt: at,
    receivedAt: at,
    requestId: `request-${String(rowId)}`,
    traceId: null,
    taskId: null,
    truncated: false,
  };
}

function detail(item: EventSummary): EventDetail {
  return {
    ...item,
    id: item.rowId,
    eventId: item.id,
    logLocator: {
      confidence: "exact_identifier",
      query: `{service="gateway"} |= "${item.requestId ?? ""}"`,
      grafanaUrl: "https://grafana.example/explore",
      from: "2026-07-29T11:56:00.000Z",
      to: "2026-07-29T12:00:00.000Z",
      criteria: {
        environment: "prod",
        service: "gateway",
        identifier: { kind: "requestId", value: item.requestId ?? "" },
        message: null,
      },
      explanation: "Matches the request identifier within the event window.",
    },
    normalized: {
      exception: {
        type: "TypeError",
        value: "Cannot read properties of undefined",
        frames: [
          {
            filename: "node_modules/router.js",
            function: "dispatch",
            lineno: 88,
            in_app: false,
          },
          {
            filename: "src/process-request.ts",
            function: "processRequest",
            lineno: 42,
            in_app: true,
          },
        ],
      },
      breadcrumbs: Array.from({ length: 8 }, (_, index) => ({
        timestamp: new Date(
          Date.parse(item.occurredAt) - (8 - index) * 1_000,
        ).toISOString(),
        category: "request",
        message: `step-${String(index + 1)}`,
      })),
      payload: {
        contexts: { runtime: { name: "node" } },
        extras: { authorization: "[REDACTED]" },
      },
    },
  };
}

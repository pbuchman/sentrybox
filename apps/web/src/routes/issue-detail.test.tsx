import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../app.js";

const occurredAt = "2026-07-29T11:58:00.000Z";
const issue = {
  id: 41,
  title: "TypeError: Cannot read properties of undefined",
  status: "unresolved" as const,
  generation: 1,
  count: 2,
  occurrenceCount: 2,
  firstSeen: "2026-07-29T08:00:00.000Z",
  lastSeen: occurredAt,
  lastReceivedAt: "2026-07-29T11:58:01.000Z",
  highestLevel: "error" as const,
  resolvedAt: null,
  createdAt: "2026-07-29T08:00:01.000Z",
  updatedAt: "2026-07-29T11:58:01.000Z",
  project: { id: "1", slug: "intexuraos-backend", name: "IntexuraOS backend" },
  facets: {
    environment: [
      {
        value: "prod",
        queryValue: "prod",
        label: "prod",
        count: 2,
        lastSeen: occurredAt,
      },
    ],
    release: [
      {
        value: null,
        queryValue: "~v1:n",
        label: "Unknown version",
        count: 1,
        lastSeen: occurredAt,
      },
    ],
    service: [
      {
        value: "whatsapp-service",
        queryValue: "~v1:s:d2hhdHNhcHAtc2VydmljZQ",
        label: "whatsapp-service",
        count: 2,
        lastSeen: occurredAt,
      },
    ],
    level: [
      {
        value: "error",
        queryValue: "error",
        label: "error",
        count: 2,
        lastSeen: occurredAt,
      },
    ],
  },
  deliveries: [
    {
      id: 77,
      deliveryId: "11111111-1111-4111-8111-111111111111",
      generation: 1,
      cause: "created" as const,
      state: "dead_letter" as const,
      attempts: 1,
      nextAttempt: null,
      lastError: "Code Agent returned 403",
      createdAt: "2026-07-29T08:00:01.000Z",
      deliveredAt: null,
      redrives: [],
    },
  ],
};

const events = {
  items: [
    {
      id: "event-sdk-id",
      rowId: 501,
      issueId: 41,
      projectId: 1,
      projectSlug: "intexuraos-backend",
      issueGeneration: 1,
      environment: "prod",
      release: null,
      service: "whatsapp-service",
      level: "error" as const,
      platform: "node",
      title: issue.title,
      message: "Cannot read value",
      exceptionType: "TypeError",
      culprit: "handleMessage",
      occurredAt,
      receivedAt: "2026-07-29T11:58:01.000Z",
      requestId: "request-42",
      traceId: null,
      taskId: null,
      truncated: false,
    },
  ],
  nextCursor: null,
};

const olderOccurrence = {
  ...events.items[0],
  id: "older-event-sdk-id",
  rowId: 500,
  occurredAt: "2026-07-29T11:30:00.000Z",
  receivedAt: "2026-07-29T11:30:01.000Z",
};

const event = {
  id: 501,
  eventId: "event-sdk-id",
  issueId: 41,
  projectId: 1,
  issueGeneration: 1,
  environment: "prod",
  release: null,
  service: "whatsapp-service",
  level: "error" as const,
  platform: "node",
  title: issue.title,
  message: "Cannot read value",
  exceptionType: "TypeError",
  culprit: "handleMessage",
  occurredAt,
  receivedAt: "2026-07-29T11:58:01.000Z",
  requestId: "request-42",
  traceId: null,
  taskId: null,
  truncated: false,
  logLocator: {
    confidence: "exact_identifier" as const,
    query:
      '{environment="prod",service="whatsapp-service"} |~ "(^|[|[:space:]])requestId=request-42([|[:space:]]|$)|\\"requestId\\":\\"request-42\\""',
    grafanaUrl: "https://grafana.example/explore?query=request-42",
    from: "2026-07-29T11:56:00.000Z",
    to: "2026-07-29T12:00:00.000Z",
    criteria: {
      environment: "prod",
      service: "whatsapp-service",
      identifier: { kind: "requestId" as const, value: "request-42" },
      message: null,
    },
    explanation:
      "Searches the event time window using the requestId correlation identifier.",
  },
  normalized: {
    id: "event-sdk-id",
    occurredAt,
    receivedAt: "2026-07-29T11:58:01.000Z",
    level: "error",
    title: issue.title,
    message: "Cannot read value",
    exception: {
      type: "TypeError",
      value: "Cannot read properties of undefined",
      mechanism: { handled: true },
      frames: [
        {
          filename: "node_modules/fastify/lib/handleRequest.js",
          function: "handleRequest",
          lineno: 100,
          in_app: false,
        },
        {
          filename: "apps/whatsapp/src/handle-message.ts",
          function: "handleMessage",
          lineno: 42,
          in_app: true,
        },
      ],
      discardedValues: 0,
    },
    breadcrumbs: [
      {
        timestamp: "2026-07-29T11:57:58.000Z",
        category: "request",
        message: "POST /messages",
        level: "info",
      },
    ],
    tags: { region: "home-dev" },
    release: null,
    environment: "prod",
    serverName: "whatsapp-service",
    platform: "node",
    logger: "whatsapp",
    requestId: "request-42",
    traceId: null,
    taskId: null,
    payload: {
      contexts: { runtime: { name: "node", version: "22.13.0" } },
      extras: { operation: "deliver message", authorization: "[REDACTED]" },
      correlations: { requestId: "request-42" },
    },
    payloadBytes: 2048,
    truncated: false,
    truncationReasons: [],
  },
};

function makeApi(overrides: Record<string, unknown> = {}) {
  return {
    listIssues: vi.fn(),
    getFacets: vi.fn(),
    getSystemStatus: vi.fn(),
    getIssue: vi.fn(async () => issue),
    listIssueEvents: vi.fn(async () => events),
    getEvent: vi.fn(async () => event),
    resolveIssue: vi.fn(async () => ({
      ...issue,
      status: "resolved" as const,
    })),
    reopenIssue: vi.fn(async () => ({
      ...issue,
      status: "unresolved" as const,
    })),
    deleteIssue: vi.fn(async () => undefined),
    retryDelivery: vi.fn(async () => ({
      id: 88,
      deliveryId: "22222222-2222-4222-8222-222222222222",
      originalOutboxId: 77,
      state: "pending" as const,
      attempts: 0,
      requestedAt: "2026-07-29T12:00:00.000Z",
      attemptedAt: null,
      lastError: null,
    })),
    eventDownloadUrl: (rowId: number) =>
      `/api/events/${String(rowId)}/download`,
    issueDownloadUrl: (id: number) => `/api/issues/${String(id)}/download`,
    ...overrides,
  };
}

describe("issue detail", () => {
  beforeEach(() => {
    vi.setSystemTime(new Date("2026-07-29T12:00:00.000Z"));
    window.history.replaceState({}, "", "/organizations/intexuraos/issues/41/");
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("loads the latest event by rowId and orders diagnostic evidence exactly", async () => {
    const api = makeApi();
    render(<App api={api} />);

    expect(
      await screen.findByRole("heading", { name: issue.title }),
    ).not.toBeNull();
    const headings = screen
      .getAllByRole("heading")
      .map((heading) => heading.textContent);
    expect(headings.indexOf("Exception and application frames")).toBeLessThan(
      headings.indexOf("Facets"),
    );
    expect(headings.indexOf("Facets")).toBeLessThan(
      headings.indexOf("Log locator"),
    );
    expect(headings.indexOf("Log locator")).toBeLessThan(
      headings.indexOf("Breadcrumbs"),
    );
    expect(headings.indexOf("Breadcrumbs")).toBeLessThan(
      headings.indexOf("Redacted contexts and extras"),
    );
    expect(headings.indexOf("Redacted contexts and extras")).toBeLessThan(
      headings.indexOf("Occurrences"),
    );
    expect(headings.indexOf("Occurrences")).toBeLessThan(
      headings.indexOf("Delivery state"),
    );
    expect(headings.indexOf("Delivery state")).toBeLessThan(
      headings.indexOf("Normalized JSON"),
    );
    expect(screen.getByText("handleMessage")).not.toBeNull();
    expect(screen.getByText("Exact identifier")).not.toBeNull();
    expect(
      screen.getByRole("link", { name: "Open matching logs" }),
    ).not.toBeNull();
    expect(
      screen.getByRole("button", { name: "Copy LogQL query" }),
    ).not.toBeNull();
    expect(screen.getByText("Unknown version")).not.toBeNull();
    expect(api.getEvent).toHaveBeenCalledWith(501);
  });

  it("keeps the loading state until core issue evidence rejects, then shows the error", async () => {
    const pendingIssue = deferred<typeof issue>();
    render(
      <App
        api={makeApi({
          getIssue: vi.fn(() => pendingIssue.promise),
        })}
      />,
    );

    expect(await screen.findByText("Loading issue evidence…")).not.toBeNull();
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByText("Loading issue evidence…")).not.toBeNull();

    await act(async () => {
      pendingIssue.reject(new Error("offline"));
      await pendingIssue.promise.catch(() => undefined);
    });

    expect(
      await screen.findByText(
        "Issue details could not be loaded. Check the private connection and try again.",
      ),
    ).not.toBeNull();
    expect(screen.queryByText("Loading issue evidence…")).toBeNull();
  });

  it("keeps every visible timestamp permanent, exact, UTC, and machine-readable", async () => {
    render(<App api={makeApi()} />);
    await screen.findByRole("heading", { name: issue.title });

    const times = Array.from(document.querySelectorAll("time"));
    expect(times.length).toBeGreaterThan(5);
    for (const time of times) {
      expect(time.getAttribute("datetime")).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
      );
      expect(time.textContent).toContain("UTC");
      expect(time.textContent).toMatch(/ago|in \d|just now/);
    }
  });

  it("resolves and reopens with labelled JSON mutations and recovery feedback", async () => {
    const api = makeApi();
    const user = userEvent.setup();
    render(<App api={api} />);
    await screen.findByRole("heading", { name: issue.title });

    await user.click(screen.getByRole("button", { name: "Resolve" }));
    expect(await screen.findByText("Issue resolved.")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Reopen" })).not.toBeNull();
    await user.click(screen.getByRole("button", { name: "Reopen" }));
    expect(await screen.findByText("Issue reopened.")).not.toBeNull();
  });

  it("provides direct downloads and a named permanent delete confirmation with focus recovery", async () => {
    const api = makeApi();
    const user = userEvent.setup();
    render(<App api={api} />);
    await screen.findByRole("heading", { name: issue.title });

    expect(
      screen.getByRole("link", { name: "Download" }).getAttribute("href"),
    ).toBe("/api/issues/41/download");

    const deleteButton = screen.getByRole("button", {
      name: "Delete permanently",
    });
    await user.click(deleteButton);
    const dialog = screen.getByRole("dialog", {
      name: "Delete issue permanently?",
    });
    expect(within(dialog).getByText(/This removes 2 events/)).not.toBeNull();
    expect(within(dialog).getByText(/no undo/i)).not.toBeNull();
    expect(document.activeElement).toBe(
      within(dialog).getByRole("button", { name: "Cancel" }),
    );
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(
      within(dialog).getByRole("button", {
        name: "Delete 2 events permanently",
      }),
    );
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(document.activeElement).toBe(deleteButton);

    await user.click(deleteButton);
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Delete 2 events permanently",
      }),
    );
    await waitFor(() => {
      expect(window.location.pathname).toBe("/");
    });
  });

  it("shows dead-letter evidence and starts a visible redrive recovery", async () => {
    const api = makeApi();
    const user = userEvent.setup();
    render(<App api={api} />);
    await screen.findByRole("heading", { name: issue.title });

    expect(screen.getByText("Dead letter")).not.toBeNull();
    expect(screen.getByText("Code Agent returned 403")).not.toBeNull();
    await user.click(screen.getByRole("button", { name: "Retry delivery" }));
    expect(await screen.findByText("Redrive queued.")).not.toBeNull();
  });

  it("keeps normalized JSON collapsed until requested", async () => {
    const user = userEvent.setup();
    render(<App api={makeApi()} />);
    await screen.findByRole("heading", { name: issue.title });

    const disclosure = screen.getByText("Normalized JSON").closest("details");
    expect(disclosure?.hasAttribute("open")).toBe(false);
    await user.click(screen.getByText("Normalized JSON"));
    expect(disclosure?.hasAttribute("open")).toBe(true);
    expect(
      within(disclosure as HTMLElement).getByText(/event-sdk-id/),
    ).not.toBeNull();
  });

  it("names empty retained evidence and the absence of a server-log query", async () => {
    const { unmount } = render(
      <App
        api={makeApi({
          listIssueEvents: vi.fn(async () => ({
            items: [],
            nextCursor: null,
          })),
        })}
      />,
    );
    expect(
      await screen.findByText("No retained occurrence evidence"),
    ).not.toBeNull();
    unmount();

    render(
      <App
        api={makeApi({
          getEvent: vi.fn(async () => ({
            ...event,
            logLocator: {
              ...event.logLocator,
              confidence: "not_applicable" as const,
              query: null,
              grafanaUrl: null,
              criteria: {
                ...event.logLocator.criteria,
                identifier: null,
              },
              explanation:
                "Browser events are not correlated with retained server logs.",
            },
          })),
        })}
      />,
    );
    expect(
      await screen.findByText(
        "No server-log query is expected for this occurrence.",
      ),
    ).not.toBeNull();
    expect(
      screen.queryByRole("link", { name: "Open matching logs" }),
    ).toBeNull();
  });

  it("names resolve, redrive, and delete failures without claiming state changed", async () => {
    const user = userEvent.setup();
    render(
      <App
        api={makeApi({
          resolveIssue: vi.fn(async () => {
            throw new Error("resolve failed");
          }),
          retryDelivery: vi.fn(async () => {
            throw new Error("redrive failed");
          }),
          deleteIssue: vi.fn(async () => {
            throw new Error("delete failed");
          }),
        })}
      />,
    );
    await screen.findByRole("heading", { name: issue.title });

    await user.click(screen.getByRole("button", { name: "Resolve" }));
    expect(
      await screen.findByText(
        "Resolve failed. The issue remains unresolved; try again.",
      ),
    ).not.toBeNull();
    expect(screen.getByRole("button", { name: "Resolve" })).not.toBeNull();

    await user.click(screen.getByRole("button", { name: "Retry delivery" }));
    expect(
      await screen.findByText(
        "Delivery retry failed. Correct the destination configuration, then try again.",
      ),
    ).not.toBeNull();

    const deleteButton = screen.getByRole("button", {
      name: "Delete permanently",
    });
    await user.click(deleteButton);
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Delete 2 events permanently",
      }),
    );
    expect(
      await screen.findByText(
        "Delete failed. No data was removed; check the private connection and try again.",
      ),
    ).not.toBeNull();
    expect(document.activeElement).toBe(deleteButton);
  });

  it("names a detail failure and recovers on retry", async () => {
    const getIssue = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(issue);
    const user = userEvent.setup();
    render(<App api={makeApi({ getIssue })} />);

    expect(
      await screen.findByText(
        "Issue details could not be loaded. Check the private connection and try again.",
      ),
    ).not.toBeNull();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(
      await screen.findByRole("heading", { name: issue.title }),
    ).not.toBeNull();
  });

  it("loads every occurrence page and offers named retry after a page failure", async () => {
    const listIssueEvents = vi
      .fn()
      .mockResolvedValueOnce({ items: events.items, nextCursor: "older-page" })
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({
        items: [olderOccurrence],
        nextCursor: null,
      });
    const user = userEvent.setup();
    render(<App api={makeApi({ listIssueEvents })} />);
    await screen.findByRole("heading", { name: issue.title });

    await user.click(
      screen.getByRole("button", { name: "Load more occurrences" }),
    );
    expect(
      await screen.findByText(
        "More occurrences could not be loaded. The current evidence is still available.",
      ),
    ).not.toBeNull();
    await user.click(
      screen.getByRole("button", { name: "Retry more occurrences" }),
    );

    expect(await screen.findByText("2026-07-29 11:30:00 UTC")).not.toBeNull();
    expect(listIssueEvents).toHaveBeenLastCalledWith(41, "older-page");
  });

  it("resolves an exact webhook event permalink across occurrence pages", async () => {
    window.history.replaceState(
      {},
      "",
      "/organizations/intexuraos/issues/41/events/older-event-sdk-id/",
    );
    const listIssueEvents = vi
      .fn()
      .mockResolvedValueOnce({ items: events.items, nextCursor: "older-page" })
      .mockResolvedValueOnce({ items: [olderOccurrence], nextCursor: null });
    const getEvent = vi.fn(async (rowId: number) => ({
      ...event,
      id: rowId,
      eventId:
        rowId === olderOccurrence.rowId
          ? olderOccurrence.id
          : events.items[0]?.id,
      occurredAt:
        rowId === olderOccurrence.rowId
          ? olderOccurrence.occurredAt
          : event.occurredAt,
    }));

    render(<App api={makeApi({ listIssueEvents, getEvent })} />);

    await screen.findByRole("heading", { name: issue.title });
    expect(listIssueEvents).toHaveBeenNthCalledWith(2, 41, "older-page");
    expect(getEvent).toHaveBeenCalledWith(olderOccurrence.rowId);
    expect(screen.getByText("2026-07-29 11:30:00 UTC")).not.toBeNull();
  });

  it("keeps the last occurrence selection when earlier requests finish later", async () => {
    let resolveOlder: ((value: typeof event) => void) | undefined;
    let resolveLatest: ((value: typeof event) => void) | undefined;
    const getEvent = vi
      .fn()
      .mockResolvedValueOnce(event)
      .mockImplementationOnce(
        async () =>
          new Promise<typeof event>((resolve) => {
            resolveOlder = resolve;
          }),
      )
      .mockImplementationOnce(
        async () =>
          new Promise<typeof event>((resolve) => {
            resolveLatest = resolve;
          }),
      );
    const user = userEvent.setup();
    render(
      <App
        api={makeApi({
          listIssueEvents: vi.fn(async () => ({
            items: [events.items[0], olderOccurrence],
            nextCursor: null,
          })),
          getEvent,
        })}
      />,
    );
    await screen.findByRole("heading", { name: issue.title });
    const occurrenceButtons = within(
      screen.getByRole("region", { name: "Occurrences" }),
    ).getAllByRole("button");

    await user.click(occurrenceButtons[1] as HTMLButtonElement);
    await user.click(occurrenceButtons[0] as HTMLButtonElement);
    resolveLatest?.({ ...event, normalized: { ...event.normalized } });
    await waitFor(() => {
      expect(occurrenceButtons[0]?.getAttribute("aria-pressed")).toBe("true");
    });
    resolveOlder?.({
      ...event,
      id: olderOccurrence.rowId,
      eventId: olderOccurrence.id,
      normalized: { ...event.normalized },
    });
    await waitFor(() => {
      expect(occurrenceButtons[0]?.getAttribute("aria-pressed")).toBe("true");
    });
  });
});

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

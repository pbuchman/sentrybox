import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../app.js";

const issue = {
  id: 41,
  project: { id: "1", slug: "intexuraos-backend", name: "IntexuraOS backend" },
  title: "TypeError: Cannot read properties of undefined",
  status: "unresolved" as const,
  generation: 1,
  count: 143,
  occurrenceCount: 143,
  matchingCount: 18,
  firstSeen: "2026-07-29T08:00:00.000Z",
  lastSeen: "2026-07-29T11:58:00.000Z",
  lastReceivedAt: "2026-07-29T11:58:01.000Z",
  highestLevel: "error" as const,
  resolvedAt: null,
  createdAt: "2026-07-29T08:00:01.000Z",
  updatedAt: "2026-07-29T11:58:01.000Z",
};

const secondIssue = {
  ...issue,
  id: 42,
  title: "RangeError: queue capacity exceeded",
  matchingCount: 1,
  occurrenceCount: 1,
};

const facets = {
  project: [
    {
      value: "intexuraos-backend",
      queryValue: "intexuraos-backend",
      label: "IntexuraOS backend",
      count: 143,
    },
  ],
  release: [
    { value: null, queryValue: "~v1:n", label: "Unknown version", count: 2 },
    {
      value: "2026.07.29-a",
      queryValue: "~v1:s:MjAyNi4wNy4yOS1h",
      label: "2026.07.29-a",
      count: 141,
    },
  ],
  environment: [
    { value: "prod", queryValue: "prod", label: "prod", count: 120 },
    { value: "dev", queryValue: "dev", label: "dev", count: 23 },
  ],
  service: [
    {
      value: "whatsapp-service",
      queryValue: "~v1:s:d2hhdHNhcHAtc2VydmljZQ",
      label: "whatsapp-service",
      count: 143,
    },
  ],
  level: [{ value: "error", queryValue: "error", label: "error", count: 143 }],
  status: [
    {
      value: "unresolved",
      queryValue: "unresolved",
      label: "unresolved",
      count: 143,
    },
  ],
};

function makeApi(overrides: Record<string, unknown> = {}) {
  const detail = {
    ...issue,
    facets: {
      environment: facets.environment.map((value) => ({
        ...value,
        lastSeen: issue.lastSeen,
      })),
      release: facets.release.map((value) => ({
        ...value,
        lastSeen: issue.lastSeen,
      })),
      service: facets.service.map((value) => ({
        ...value,
        lastSeen: issue.lastSeen,
      })),
      level: facets.level.map((value) => ({
        ...value,
        lastSeen: issue.lastSeen,
      })),
    },
    deliveries: [],
  };
  return {
    listIssues: vi.fn(async () => ({
      items: [issue],
      nextCursor: null,
      facets,
    })),
    getSystemStatus: vi.fn(async () => ({
      status: "ok" as const,
      storage: {
        physicalBytes: 1_932_735_283,
        budgetBytes: 5_368_709_120,
      },
      ingest: { accepting: true },
      outbox: { deadLetter: 0 },
    })),
    getFacets: vi.fn(async () => facets),
    getIssue: vi.fn(async () => detail),
    listIssueEvents: vi.fn(),
    getEvent: vi.fn(),
    resolveIssue: vi.fn(),
    reopenIssue: vi.fn(),
    deleteIssue: vi.fn(),
    retryDelivery: vi.fn(),
    eventDownloadUrl: (rowId: number) =>
      `/api/events/${String(rowId)}/download`,
    issueDownloadUrl: (id: number) => `/api/issues/${String(id)}/download`,
    ...overrides,
  };
}

describe("issue list", () => {
  beforeEach(() => {
    vi.setSystemTime(new Date("2026-07-29T12:00:00.000Z"));
    window.history.replaceState({}, "", "/");
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("opens unresolved issues with operational counts, storage, facets, and exact plus relative times", async () => {
    const api = makeApi();
    render(<App api={api} />);

    expect(
      await screen.findByRole("heading", { name: /issues/i }),
    ).not.toBeNull();
    expect(screen.getByText("Shown 1 · Unresolved shown 1")).not.toBeNull();
    expect(screen.getByText(/Storage 1\.8 \/ 5 GiB/)).not.toBeNull();
    expect(screen.getByRole("link", { name: issue.title })).not.toBeNull();
    expect(screen.getByText("IntexuraOS backend")).not.toBeNull();
    expect(screen.getByText("prod")).not.toBeNull();
    expect(screen.getByText("2026.07.29-a")).not.toBeNull();
    expect(screen.getByText("whatsapp-service")).not.toBeNull();
    expect(screen.getByText("18 matching / 143 total")).not.toBeNull();

    const times = screen.getAllByText("2026-07-29 11:58:00 UTC");
    expect(times.length).toBeGreaterThan(0);
    const time = times[0]?.closest("time");
    expect(time?.getAttribute("datetime")).toBe(issue.lastSeen);
    expect(time?.textContent).toContain("2 minutes ago");
    expect(window.location.search).toBe("?status=unresolved");
  });

  it("combines every filter and writes server-provided facet query values to a shareable URL", async () => {
    const user = userEvent.setup();
    render(<App api={makeApi()} />);
    await screen.findByRole("link", { name: issue.title });

    await user.selectOptions(screen.getByLabelText("Project"), [
      "intexuraos-backend",
    ]);
    await user.selectOptions(screen.getByLabelText("Version"), [
      "~v1:n",
      "~v1:s:MjAyNi4wNy4yOS1h",
    ]);
    await user.selectOptions(screen.getByLabelText("Environment"), [
      "prod",
      "dev",
    ]);
    await user.selectOptions(screen.getByLabelText("Service"), [
      "~v1:s:d2hhdHNhcHAtc2VydmljZQ",
    ]);
    await user.selectOptions(screen.getByLabelText("Level"), ["error"]);
    await user.selectOptions(screen.getByLabelText("Status"), ["resolved"]);
    await user.type(screen.getByLabelText("Search"), "undefined");
    fireEvent.change(screen.getByLabelText("From (UTC)"), {
      target: { value: "2026-07-28T08:30:00.000" },
    });
    fireEvent.change(screen.getByLabelText("To (UTC)"), {
      target: { value: "2026-07-29T12:00:00.000" },
    });
    fireEvent.submit(screen.getByRole("search"));

    await waitFor(() => {
      const query = new URLSearchParams(window.location.search);
      expect(query.getAll("project")).toEqual(["intexuraos-backend"]);
      expect(query.getAll("release")).toEqual([
        "~v1:n",
        "~v1:s:MjAyNi4wNy4yOS1h",
      ]);
      expect(query.getAll("environment")).toEqual(["prod", "dev"]);
      expect(query.getAll("service")).toEqual(["~v1:s:d2hhdHNhcHAtc2VydmljZQ"]);
      expect(query.getAll("level")).toEqual(["error"]);
      expect(query.getAll("status")).toEqual(["resolved"]);
      expect(query.get("query")).toBe("undefined");
      expect(query.get("from")).toBe("2026-07-28T08:30:00.000Z");
      expect(query.get("to")).toBe("2026-07-29T12:00:00.000Z");
    });
  });

  it("restores combined filter state from the URL", async () => {
    window.history.replaceState(
      {},
      "",
      "/?project=intexuraos-backend&release=~v1%3An&environment=prod&service=~v1%3As%3Ad2hhdHNhcHAtc2VydmljZQ&level=error&status=resolved&query=timeout&from=2026-07-28T08%3A30%3A00.000Z&to=2026-07-29T12%3A00%3A00.000Z",
    );
    render(<App api={makeApi()} />);
    await screen.findByRole("link", { name: issue.title });

    expect(
      Array.from(
        (screen.getByLabelText("Version") as HTMLSelectElement).selectedOptions,
        (option) => option.value,
      ),
    ).toEqual(["~v1:n"]);
    expect((screen.getByLabelText("Search") as HTMLInputElement).value).toBe(
      "timeout",
    );
    expect((screen.getByLabelText("Status") as HTMLSelectElement).value).toBe(
      "resolved",
    );
    expect(
      (screen.getByLabelText("From (UTC)") as HTMLInputElement).value,
    ).toBe("2026-07-28T08:30");
    expect((screen.getByLabelText("To (UTC)") as HTMLInputElement).value).toBe(
      "2026-07-29T12:00",
    );
  });

  it("refreshes relative time after 30 seconds without changing exact UTC or datetime", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-29T12:00:00.000Z"));
    render(<App api={makeApi()} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const time = screen
      .getAllByText("2026-07-29 11:58:00 UTC")[0]
      ?.closest("time");
    expect(time?.textContent).toContain("2 minutes ago");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(time?.textContent).toContain("3 minutes ago");
    expect(time?.textContent).toContain("2026-07-29 11:58:00 UTC");
    expect(time?.getAttribute("datetime")).toBe(issue.lastSeen);
  });

  it("explains no matches and clears active filters", async () => {
    const user = userEvent.setup();
    window.history.replaceState({}, "", "/?status=unresolved&query=missing");
    render(
      <App
        api={makeApi({
          listIssues: vi.fn(async () => ({
            items: [],
            nextCursor: null,
            facets,
          })),
        })}
      />,
    );

    expect(
      await screen.findByText("No issues match these filters"),
    ).not.toBeNull();
    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    await waitFor(() => {
      expect(window.location.search).toBe("?status=unresolved");
    });
  });

  it("names a list failure and recovers when retried", async () => {
    const listIssues = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ items: [issue], nextCursor: null, facets });
    const user = userEvent.setup();
    render(<App api={makeApi({ listIssues })} />);

    expect(
      await screen.findByText(
        "Issues could not be loaded. Check the private connection and try again.",
      ),
    ).not.toBeNull();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(
      await screen.findByRole("link", { name: issue.title }),
    ).not.toBeNull();
  });

  it("keeps a valid list visible when facets, system status, or row evidence are unavailable", async () => {
    render(
      <App
        api={makeApi({
          getFacets: vi.fn(async () => {
            throw new Error("facets offline");
          }),
          getSystemStatus: vi.fn(async () => {
            throw new Error("status offline");
          }),
          getIssue: vi.fn(async () => {
            throw new Error("detail offline");
          }),
        })}
      />,
    );

    expect(
      await screen.findByRole("link", { name: issue.title }),
    ).not.toBeNull();
    expect(screen.getByText("Storage unavailable")).not.toBeNull();
    expect(screen.getByText("Facet evidence unavailable")).not.toBeNull();
    expect(screen.queryByText("prod")).toBeNull();
  });

  it("names a load-more failure and retries the same page", async () => {
    const listIssues = vi
      .fn()
      .mockResolvedValueOnce({
        items: [issue],
        nextCursor: "next-page",
        facets,
      })
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({
        items: [secondIssue],
        nextCursor: null,
        facets,
      });
    const user = userEvent.setup();
    render(<App api={makeApi({ listIssues })} />);
    await screen.findByRole("link", { name: issue.title });

    await user.click(screen.getByRole("button", { name: "Load more issues" }));
    expect(
      await screen.findByText(
        "More issues could not be loaded. The current results are still available.",
      ),
    ).not.toBeNull();
    await user.click(screen.getByRole("button", { name: "Retry more issues" }));

    expect(
      await screen.findByRole("link", { name: secondIssue.title }),
    ).not.toBeNull();
    expect(screen.getByText("Shown 2 · Unresolved shown 2")).not.toBeNull();
    expect(listIssues).toHaveBeenLastCalledWith(
      expect.objectContaining({ get: expect.any(Function) }),
    );
    expect(
      (listIssues.mock.calls.at(-1)?.[0] as URLSearchParams).get("cursor"),
    ).toBe("next-page");
  });
});

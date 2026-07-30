import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFixtureApi } from "../api/fixture-api.js";
import { App } from "../app.js";

describe("project-first issue list", () => {
  beforeEach(() => {
    vi.setSystemTime(new Date("2026-07-30T12:00:00.000Z"));
    window.history.replaceState({}, "", "/");
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("requires a project before showing issues and stores the scope in the URL", async () => {
    render(<App api={createFixtureApi()} />);

    const chooser = await screen.findByRole("heading", {
      name: "Choose a project",
    });
    const chooserSection = chooser.closest("section");
    expect(chooserSection).not.toBeNull();
    await userEvent.click(
      within(chooserSection!).getByRole("button", { name: "IntexuraOS" }),
    );

    expect(
      await screen.findByRole("heading", { name: "Issues" }),
    ).not.toBeNull();
    expect(
      screen.getByRole("link", {
        name: "TypeError: Cannot read properties of undefined",
      }),
    ).not.toBeNull();
    expect(window.location.search).toBe(
      "?project=intexuraos&status=unresolved",
    );
    expect(screen.getByText("System healthy")).not.toBeNull();
  });

  it("clears dependent filters when the active project changes", async () => {
    window.history.replaceState(
      {},
      "",
      "/?project=intexuraos&status=unresolved&level=error&sort=events-desc",
    );
    render(<App api={createFixtureApi()} />);
    expect(
      await screen.findByRole("heading", { name: "Issues" }),
    ).not.toBeNull();

    await userEvent.click(
      screen.getByRole("button", { name: "Billing Portal" }),
    );

    await waitFor(() =>
      expect(window.location.search).toBe(
        "?project=billing-portal&status=unresolved",
      ),
    );
    expect(
      await screen.findByRole("link", {
        name: "Invoice export failed during PDF rendering",
      }),
    ).not.toBeNull();
  });

  it("sends project-scoped filter values to the API and exposes removable chips", async () => {
    window.history.replaceState(
      {},
      "",
      "/?project=intexuraos&status=unresolved",
    );
    const base = createFixtureApi();
    const listIssues = vi.fn(base.listIssues);
    render(<App api={{ ...base, listIssues }} />);
    await screen.findByRole("link", {
      name: "TypeError: Cannot read properties of undefined",
    });

    await userEvent.click(screen.getByRole("button", { name: "Filters" }));
    await userEvent.click(screen.getByRole("checkbox", { name: /warn/i }));
    expect(window.location.search).not.toContain("level=warn");
    await userEvent.click(screen.getByRole("button", { name: "Show issues" }));

    await waitFor(() => {
      const query = listIssues.mock.calls.at(-1)?.[0];
      expect(query?.get("project")).toBe("intexuraos");
      expect(query?.get("level")).toBe("warn");
    });
    expect(window.location.search).toContain("level=warn");
    expect(screen.getByRole("button", { name: /warn/i })).not.toBeNull();
    expect(
      await screen.findByRole("link", {
        name: "Message delivery returned an invalid response",
      }),
    ).not.toBeNull();
  });

  it("sorts the complete filtered project scope by event count", async () => {
    window.history.replaceState(
      {},
      "",
      "/?project=intexuraos&status=unresolved",
    );
    render(<App api={createFixtureApi()} />);
    await screen.findByRole("link", {
      name: "TypeError: Cannot read properties of undefined",
    });

    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: "Sort issues" }),
      "events-asc",
    );

    await waitFor(() => {
      const links =
        document.querySelectorAll<HTMLAnchorElement>(".issue-table-link");
      expect(links[0]?.textContent).toContain(
        "Message delivery returned an invalid response",
      );
      expect(links[2]?.textContent).toContain(
        "TimeoutError: upstream request exceeded 10s",
      );
    });
    expect(window.location.search).toContain("sort=events-asc");
  });

  it("persists the All status in the URL without sending it to the API", async () => {
    window.history.replaceState(
      {},
      "",
      "/?project=intexuraos&status=unresolved",
    );
    const base = createFixtureApi();
    const listIssues = vi.fn(base.listIssues);
    const view = render(<App api={{ ...base, listIssues }} />);
    await screen.findByRole("link", {
      name: "TypeError: Cannot read properties of undefined",
    });

    await userEvent.click(screen.getByRole("button", { name: "All" }));

    await waitFor(() =>
      expect(window.location.search).toBe("?project=intexuraos&status=all"),
    );
    expect(listIssues.mock.calls.at(-1)?.[0].has("status")).toBe(false);

    view.unmount();
    const reloaded = createFixtureApi();
    const reloadedListIssues = vi.fn(reloaded.listIssues);
    render(<App api={{ ...reloaded, listIssues: reloadedListIssues }} />);
    await screen.findByRole("link", {
      name: "TypeError: Cannot read properties of undefined",
    });
    expect(
      screen.getByRole("button", { name: "All" }).getAttribute("aria-pressed"),
    ).toBe("true");
    expect(reloadedListIssues.mock.calls.at(-1)?.[0].has("status")).toBe(false);
  });

  it("canonicalizes unsupported list state from a shared URL", async () => {
    window.history.replaceState(
      {},
      "",
      "/?project=intexuraos&status=broken&sort=unknown&cursor=stale",
    );
    const base = createFixtureApi();
    const listIssues = vi.fn(base.listIssues);
    render(<App api={{ ...base, listIssues }} />);

    await screen.findByRole("link", {
      name: "TypeError: Cannot read properties of undefined",
    });

    expect(window.location.search).toBe(
      "?project=intexuraos&status=unresolved",
    );
    expect(
      screen.getByRole<HTMLSelectElement>("combobox", {
        name: "Sort issues",
      }).value,
    ).toBe("last-desc");
    expect(listIssues.mock.calls.at(-1)?.[0].has("limit")).toBe(false);
  });

  it("debounces search and keeps the project constraint", async () => {
    window.history.replaceState(
      {},
      "",
      "/?project=intexuraos&status=unresolved",
    );
    const base = createFixtureApi();
    const listIssues = vi.fn(base.listIssues);
    render(<App api={{ ...base, listIssues }} />);
    await screen.findByRole("link", {
      name: "TypeError: Cannot read properties of undefined",
    });

    await userEvent.type(
      screen.getByRole("searchbox", { name: "Search issues" }),
      "timeout",
    );

    await waitFor(() =>
      expect(window.location.search).toContain("query=timeout"),
    );
    expect(
      await screen.findByRole("link", {
        name: "TimeoutError: upstream request exceeded 10s",
      }),
    ).not.toBeNull();
    const query = listIssues.mock.calls.at(-1)?.[0];
    expect(query?.get("project")).toBe("intexuraos");
  });

  it("explains an empty result and restores the project default", async () => {
    window.history.replaceState(
      {},
      "",
      "/?project=intexuraos&status=unresolved&level=fatal&query=missing",
    );
    render(<App api={createFixtureApi()} />);
    expect(
      await screen.findByRole("heading", {
        name: "No issues match these filters",
      }),
    ).not.toBeNull();

    await userEvent.click(
      screen.getByRole("button", { name: "Clear filters" }),
    );

    expect(
      await screen.findByRole("link", {
        name: "TypeError: Cannot read properties of undefined",
      }),
    ).not.toBeNull();
    expect(window.location.search).toBe(
      "?project=intexuraos&status=unresolved",
    );
  });

  it("names a project-catalog failure and recovers without reloading the page", async () => {
    const base = createFixtureApi();
    const getFacets = vi
      .fn(base.getFacets)
      .mockRejectedValueOnce(new Error("offline"));
    render(<App api={{ ...base, getFacets }} />);

    expect(
      await screen.findByRole("heading", {
        name: "Projects could not be loaded",
      }),
    ).not.toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(
      await screen.findByRole("heading", { name: "Choose a project" }),
    ).not.toBeNull();
    expect(getFacets).toHaveBeenCalledTimes(2);
  });
});

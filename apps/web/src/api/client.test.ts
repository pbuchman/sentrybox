import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "./client.js";

describe("private API client", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("preserves repeated filters and server-returned nullable query values", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ items: [], nextCursor: null, facets: {} }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
    const api = createApiClient(fetcher);
    const filters = new URLSearchParams();
    filters.append("release", "~v1:n");
    filters.append("release", "~v1:s:YWJj");
    filters.append("environment", "prod");
    filters.set("status", "unresolved");

    await api.listIssues(filters);

    expect(fetcher).toHaveBeenCalledWith(
      "/api/issues?release=%7Ev1%3An&release=%7Ev1%3As%3AYWJj&environment=prod&status=unresolved",
      expect.objectContaining({ headers: { Accept: "application/json" } }),
    );
  });

  it.each([
    ["resolveIssue", "/api/issues/41/resolve"],
    ["reopenIssue", "/api/issues/41/reopen"],
    ["retryDelivery", "/api/webhook-deliveries/77/retry"],
  ] as const)("%s sends a same-origin JSON POST", async (method, path) => {
    const fetcher = vi.fn(
      async () =>
        new Response(JSON.stringify({ id: 41 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const api = createApiClient(fetcher);

    await api[method](method === "retryDelivery" ? 77 : 41);

    expect(fetcher).toHaveBeenCalledWith(path, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: "{}",
    });
  });

  it("deletes with a non-empty same-origin JSON request", async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 204 }));
    const api = createApiClient(fetcher);

    await api.deleteIssue(41);

    expect(fetcher).toHaveBeenCalledWith("/api/issues/41", {
      method: "DELETE",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: "{}",
    });
  });

  it("uses the occurrence rowId for event routes and downloads", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(JSON.stringify({ id: 501, eventId: "sdk-event" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const api = createApiClient(fetcher);

    await api.getEvent(501);

    expect(fetcher).toHaveBeenCalledWith(
      "/api/events/501",
      expect.objectContaining({ headers: { Accept: "application/json" } }),
    );
    expect(api.eventDownloadUrl(501)).toBe("/api/events/501/download");
  });

  it("passes an opaque cursor when loading another occurrence page", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(JSON.stringify({ items: [], nextCursor: null }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const api = createApiClient(fetcher);

    await api.listIssueEvents(41, "opaque+/cursor");

    expect(fetcher).toHaveBeenCalledWith(
      "/api/issues/41/events?cursor=opaque%2B%2Fcursor",
      expect.objectContaining({ headers: { Accept: "application/json" } }),
    );
  });
});

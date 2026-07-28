import { describe, expect, it } from "vitest";
import { buildLogLocator } from "./query-builder.js";

const GRAFANA = new URL("https://grafana.example/explore?orgId=1");
const OCCURRED_AT = "2026-07-28T10:00:00.000Z";

function event(
  overrides: Partial<Parameters<typeof buildLogLocator>[0]> = {},
): Parameters<typeof buildLogLocator>[0] {
  return {
    occurredAt: OCCURRED_AT,
    environment: "dev",
    service: "api",
    platform: "node",
    traceId: null,
    requestId: null,
    taskId: null,
    message: "worker failed",
    exceptionType: "TypeError",
    title: "TypeError: worker failed",
    ...overrides,
  };
}

describe("buildLogLocator", () => {
  it.each([
    [
      { traceId: "trace-1", requestId: "request-1", taskId: "task-1" },
      "traceId",
      "trace-1",
    ],
    [{ requestId: "request-1", taskId: "task-1" }, "requestId", "request-1"],
    [{ taskId: "task-1" }, "taskId", "task-1"],
  ] as const)(
    "uses deterministic identifier priority for %o",
    (identifiers, kind, value) => {
      const locator = buildLogLocator(event(identifiers), {
        grafanaExploreUrl: GRAFANA,
      });

      expect(locator).toMatchObject({
        confidence: "exact_identifier",
        from: "2026-07-28T09:58:00.000Z",
        to: "2026-07-28T10:02:00.000Z",
        criteria: {
          environment: "dev",
          service: "api",
          identifier: { kind, value },
          message: null,
        },
      });
      expect(locator.query).toContain(`| ${kind}=`);
      expect(locator.query).toContain(value);
    },
  );

  it("uses message, then exception type, then title as non-exact fallback", () => {
    const message = buildLogLocator(event(), { grafanaExploreUrl: GRAFANA });
    const exception = buildLogLocator(event({ message: null }), {
      grafanaExploreUrl: GRAFANA,
    });
    const title = buildLogLocator(
      event({ message: null, exceptionType: null }),
      { grafanaExploreUrl: GRAFANA },
    );

    expect(message).toMatchObject({
      confidence: "time_message_fallback",
      criteria: { message: "worker failed", identifier: null },
    });
    expect(exception).toMatchObject({
      confidence: "time_message_fallback",
      criteria: { message: "TypeError", identifier: null },
    });
    expect(title).toMatchObject({
      confidence: "time_message_fallback",
      criteria: { message: "TypeError: worker failed", identifier: null },
    });
    expect(message.explanation).not.toMatch(/\bexact\b/iu);
  });

  it("marks a browser JavaScript event without a server locator not applicable", () => {
    expect(
      buildLogLocator(
        event({
          platform: "javascript",
          service: null,
          message: "browser render failed",
        }),
        { grafanaExploreUrl: GRAFANA },
      ),
    ).toEqual({
      confidence: "not_applicable",
      query: null,
      grafanaUrl: null,
      from: "2026-07-28T09:58:00.000Z",
      to: "2026-07-28T10:02:00.000Z",
      criteria: {
        environment: "dev",
        service: null,
        identifier: null,
        message: null,
      },
      explanation:
        "Browser-only events without a server identifier are not expected in server logs.",
    });
  });

  it("escapes labels, literals, regex metacharacters, quotes, slashes, newlines, and backticks", () => {
    const locator = buildLogLocator(
      event({
        environment: 'dev"\\\n`',
        service: 'api"\\\n`',
        message: 'boom .* [x] "slash\\\n`',
      }),
      { grafanaExploreUrl: GRAFANA },
    );

    expect(locator.query).not.toContain("\n");
    expect(locator.query).not.toContain("`");
    expect(locator.query).toContain('\\"');
    expect(locator.query).toContain("\\\\");
    expect(locator.query).toContain("\\n");
    expect(locator.query).toContain("\\u0060");
    expect(locator.query).toContain("\\\\.\\\\*");
    expect(locator.query).toContain("\\\\[x\\\\]");
  });

  it("uses URLSearchParams without corrupting the query or exact time boundaries", () => {
    const locator = buildLogLocator(event({ traceId: "a&b#c d" }), {
      grafanaExploreUrl: GRAFANA,
    });
    const url = new URL(locator.grafanaUrl ?? "");

    expect(url.origin + url.pathname).toBe("https://grafana.example/explore");
    expect(url.searchParams.get("orgId")).toBe("1");
    expect(url.searchParams.get("from")).toBe(
      String(Date.parse("2026-07-28T09:58:00.000Z")),
    );
    expect(url.searchParams.get("to")).toBe(
      String(Date.parse("2026-07-28T10:02:00.000Z")),
    );
    expect(url.searchParams.get("query")).toBe(locator.query);
  });

  it("rejects invalid occurrence timestamps", () => {
    expect(() =>
      buildLogLocator(event({ occurredAt: "invalid" }), {
        grafanaExploreUrl: GRAFANA,
      }),
    ).toThrow(/occurrence timestamp/u);
  });
});

import { describe, expect, it } from "vitest";
import { buildLogLocator } from "./query-builder.js";

const GRAFANA = new URL(
  "https://grafana.example/explore?orgId=1&datasource=grafanacloud-logs",
);
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
      "requestId",
      "request-1",
    ],
    [{ traceId: "trace-1", taskId: "task-1" }, "taskId", "task-1"],
    [{ traceId: "trace-1" }, "traceId", "trace-1"],
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
      expect(locator.query).toContain(`{environment="dev",service="api"} |~ `);
      expect(locator.query).toContain(`${kind}=${value}`);
      expect(locator.query).not.toContain("| json");
      expect(locator.query).not.toContain("|=");
    },
  );

  it("matches the exact correlation field in Home Dev PM2 and production JSON lines", () => {
    const locator = buildLogLocator(event({ requestId: "request-from-pm2" }), {
      grafanaExploreUrl: GRAFANA,
    });
    const matcher = logLineMatcher(locator.query);

    expect(
      matcher.test(
        "12:00:00 | WARN | api | failed | requestId=request-from-pm2",
      ),
    ).toBe(true);
    expect(
      matcher.test('{"requestId":"request-from-pm2","msg":"failed"}'),
    ).toBe(true);
    expect(matcher.test("requestId=request-from-pm2-other")).toBe(false);
    expect(matcher.test("otherRequestId=request-from-pm2")).toBe(false);
  });

  it.each([
    'request-"quoted"',
    "request-back\\slash",
    "request-control\n\t\u0000end",
  ])("matches JSON-serialized production correlation value %j", (requestId) => {
    const locator = buildLogLocator(event({ requestId }), {
      grafanaExploreUrl: GRAFANA,
    });
    const matcher = logLineMatcher(locator.query);

    expect(matcher.test(JSON.stringify({ requestId, msg: "failed" }))).toBe(
      true,
    );
    expect(
      matcher.test(
        JSON.stringify({ requestId: `${requestId}-suffix`, msg: "failed" }),
      ),
    ).toBe(false);
  });

  it("uses Pino extras before an SDK-generated trace context and falls back when only that trace exists", () => {
    const withRequest = buildLogLocator(
      event({
        traceId: "sdk-generated-trace",
        requestId: "12345678-1234-4123-8123-123456789abc",
        correlationEvidence: {
          requestId: {
            source: "extras",
            alias: "requestId",
            value: "12345678-1234-4123-8123-123456789abc",
          },
          traceId: {
            source: "contexts",
            alias: "trace_id",
            value: "sdk-generated-trace",
          },
        },
      }),
      { grafanaExploreUrl: GRAFANA },
    );
    const sdkTraceOnly = buildLogLocator(
      event({
        traceId: "sdk-generated-trace",
        correlationEvidence: {
          traceId: {
            source: "contexts",
            alias: "trace_id",
            value: "sdk-generated-trace",
          },
        },
      }),
      { grafanaExploreUrl: GRAFANA },
    );

    expect(withRequest.criteria.identifier).toEqual({
      kind: "requestId",
      value: "12345678-1234-4123-8123-123456789abc",
    });
    expect(withRequest.query).not.toContain("sdk-generated-trace");
    expect(sdkTraceOnly).toMatchObject({
      confidence: "time_message_fallback",
      criteria: { identifier: null, message: "worker failed" },
    });
  });

  it("uses the transported log title before a generic exception type", () => {
    const locator = buildLogLocator(
      event({
        message: null,
        exceptionType: "Error",
        title: "Failed to fetch Linear issue",
        traceId: "sdk-generated-trace",
        correlationEvidence: {
          traceId: {
            source: "contexts",
            alias: "trace_id",
            value: "sdk-generated-trace",
          },
        },
      }),
      { grafanaExploreUrl: GRAFANA },
    );

    expect(locator).toMatchObject({
      confidence: "time_message_fallback",
      criteria: {
        identifier: null,
        message: "Failed to fetch Linear issue",
      },
    });
    expect(locator.query).toBe(
      '{environment="dev",service="api"} |~ "Failed to fetch Linear issue"',
    );
  });

  it("uses message, then title, then exception type as non-exact fallback", () => {
    const message = buildLogLocator(event(), { grafanaExploreUrl: GRAFANA });
    const title = buildLogLocator(event({ message: null }), {
      grafanaExploreUrl: GRAFANA,
    });
    const exception = buildLogLocator(event({ message: null, title: "" }), {
      grafanaExploreUrl: GRAFANA,
    });

    expect(message).toMatchObject({
      confidence: "time_message_fallback",
      criteria: { message: "worker failed", identifier: null },
    });
    expect(title).toMatchObject({
      confidence: "time_message_fallback",
      criteria: { message: "TypeError: worker failed", identifier: null },
    });
    expect(exception).toMatchObject({
      confidence: "time_message_fallback",
      criteria: { message: "TypeError", identifier: null },
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

  it("marks browser JavaScript without an exact identifier not applicable even with a decorative service", () => {
    expect(
      buildLogLocator(
        event({
          platform: "javascript",
          service: "web-shell",
          message: "browser render failed",
        }),
        { grafanaExploreUrl: GRAFANA },
      ),
    ).toMatchObject({
      confidence: "not_applicable",
      query: null,
      grafanaUrl: null,
      criteria: { service: "web-shell", identifier: null, message: null },
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
    expect(locator.query).toContain("`");
    expect(locator.query).toContain('\\"');
    expect(locator.query).toContain("\\\\");
    expect(locator.query).toContain("\\u000A");
    expect(locator.query).not.toContain("\\`");
    expect(locator.query).toContain("\\\\.\\\\*");
    expect(locator.query).toContain("\\\\[x\\\\]");
  });

  it("encodes every C0 control and lone surrogate in labels, identifiers, and fallback regex strings", () => {
    const adversarial = `nul\0back\bform\fescape\u001bunit\u0001vertical\u000bunit-separator\u001fdelete\u007fquote"slash/back\\carriage\rtab\tline\nend\ud800`;
    const expectedEscapes = [
      "\\u0000",
      "\\u0008",
      "\\u000C",
      "\\u001B",
      "\\u0001",
      "\\u000B",
      "\\u001F",
      "\\u007F",
      "\\u000D",
      "\\u0009",
      '\\"',
      "\\\\",
      "\\u000A",
      "\\uFFFD",
    ];
    const exact = buildLogLocator(
      event({
        environment: adversarial,
        service: adversarial,
        traceId: adversarial,
      }),
      { grafanaExploreUrl: GRAFANA },
    );
    const fallback = buildLogLocator(
      event({
        environment: adversarial,
        service: adversarial,
        message: adversarial,
      }),
      { grafanaExploreUrl: GRAFANA },
    );

    for (const locator of [exact, fallback]) {
      for (const escaped of expectedEscapes) {
        expect(locator.query).toContain(escaped);
      }
      expect(
        [...(locator.query ?? "")].some((character) => {
          const code = character.charCodeAt(0);
          return (
            code <= 0x1f || code === 0x7f || (code >= 0xd800 && code <= 0xdfff)
          );
        }),
      ).toBe(false);
      expect(grafanaPane(locator.grafanaUrl).queries[0]?.expr).toBe(
        locator.query,
      );
    }
  });

  it("uses URLSearchParams without corrupting the query or exact time boundaries", () => {
    const locator = buildLogLocator(event({ traceId: "a&b#c d" }), {
      grafanaExploreUrl: GRAFANA,
    });
    const url = new URL(locator.grafanaUrl ?? "");

    expect(url.origin + url.pathname).toBe("https://grafana.example/explore");
    expect(url.searchParams.get("orgId")).toBe("1");
    expect(url.searchParams.get("schemaVersion")).toBe("1");
    expect(url.searchParams.has("datasource")).toBe(false);
    const pane = grafanaPane(locator.grafanaUrl);
    expect(pane.datasource).toBe("grafanacloud-logs");
    expect(pane.range).toEqual({
      from: String(Date.parse("2026-07-28T09:58:00.000Z")),
      to: String(Date.parse("2026-07-28T10:02:00.000Z")),
    });
    expect(pane.queries[0]).toMatchObject({
      refId: "A",
      expr: locator.query,
      queryType: "range",
      datasource: { uid: "grafanacloud-logs", type: "loki" },
    });
  });

  it("rejects invalid occurrence timestamps", () => {
    expect(() =>
      buildLogLocator(event({ occurredAt: "invalid" }), {
        grafanaExploreUrl: GRAFANA,
      }),
    ).toThrow(/occurrence timestamp/u);
  });
});

interface GrafanaPane {
  readonly datasource: string;
  readonly queries: readonly { readonly expr: string }[];
  readonly range: { readonly from: string; readonly to: string };
}

function grafanaPane(url: string | null): GrafanaPane {
  const panes = new URL(url ?? "").searchParams.get("panes");
  expect(panes).not.toBeNull();
  const pane = (
    JSON.parse(panes ?? "") as Record<string, GrafanaPane | undefined>
  )["A"];
  if (pane === undefined) throw new Error("Grafana pane A is missing");
  return pane;
}

function logLineMatcher(query: string | null): RegExp {
  const match = /\|~ ("(?:\\.|[^"])*")$/u.exec(query ?? "");
  expect(match?.[1]).toBeDefined();
  const re2Pattern = JSON.parse(match?.[1] ?? '""') as string;
  return new RegExp(re2Pattern.replaceAll("[|[:space:]]", "[|\\s]"), "u");
}

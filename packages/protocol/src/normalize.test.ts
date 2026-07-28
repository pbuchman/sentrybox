import { describe, expect, it } from "vitest";

import { admitEvent, normalizeEvent } from "./index.js";

describe("admitEvent", () => {
  it.each([
    ["warning", { accepted: true, level: "warn" }],
    ["warn", { accepted: true, level: "warn" }],
    ["error", { accepted: true, level: "error" }],
    ["fatal", { accepted: true, level: "fatal" }],
  ] as const)("accepts %s as a canonical error level", (level, expected) => {
    expect(admitEvent({ level })).toEqual(expected);
  });

  it.each(["debug", "info", "trace", "notice", "unknown"])(
    "discards %s below the error threshold",
    (level) => {
      expect(admitEvent({ level })).toEqual({
        accepted: false,
        reason: "below_threshold",
      });
    },
  );

  it("accepts an event without a level when it has a non-empty exception", () => {
    expect(
      admitEvent({
        exception: {
          values: [{ type: "Error", value: "Database unavailable" }],
        },
      }),
    ).toEqual({ accepted: true, level: "error" });
  });

  it("discards an event without a level or exception", () => {
    expect(admitEvent({ message: "ordinary log line" })).toEqual({
      accepted: false,
      reason: "below_threshold",
    });
  });
});

describe("normalizeEvent", () => {
  it("uses the documented correlation precedence and preserves the selected source alias", () => {
    const result = normalizeEvent(
      {
        event_id: "event-1",
        level: "error",
        timestamp: "2026-07-28T12:00:00.000Z",
        message: "Could not process order",
        tags: {
          reqId: "tag-req",
          trace_id: "tag-trace",
          task_id: "tag-task",
        },
        extra: {
          requestId: "extra-request",
          traceId: "extra-trace",
          taskId: "extra-task",
        },
        contexts: {
          request: { requestId: "context-request" },
          trace: { trace_id: "context-trace" },
        },
      },
      "2026-07-28T12:01:00.000Z",
    );

    expect(result).toMatchObject({
      accepted: true,
      event: {
        id: "event-1",
        requestId: "tag-req",
        traceId: "tag-trace",
        taskId: "tag-task",
        tags: { reqId: "tag-req" },
        payload: {
          correlations: {
            requestId: { source: "tags", alias: "reqId", value: "tag-req" },
          },
        },
      },
    });
  });

  it("prefers requestId over reqId within each correlation source", () => {
    const result = normalizeEvent(
      {
        event_id: "event-2",
        level: "error",
        timestamp: "2026-07-28T12:00:00.000Z",
        tags: { reqId: "lower-priority", requestId: "selected" },
      },
      "2026-07-28T12:01:00.000Z",
    );

    expect(result).toMatchObject({
      accepted: true,
      event: { requestId: "selected" },
    });
  });

  it("uses direct extras before contexts when tags have no correlation", () => {
    const result = normalizeEvent(
      {
        event_id: "event-2b",
        level: "error",
        timestamp: "2026-07-28T12:00:00.000Z",
        extra: { req_id: "extra-request", trace_id: "extra-trace" },
        contexts: {
          request: { request_id: "context-request" },
          trace: { trace_id: "context-trace" },
        },
      },
      "2026-07-28T12:01:00.000Z",
    );

    expect(result).toMatchObject({
      accepted: true,
      event: { requestId: "extra-request", traceId: "extra-trace" },
    });
  });

  it("does not invent a canonical correlation from a redacted identifier", () => {
    const secret = "Bearer correlation-secret";
    const result = normalizeEvent(
      {
        event_id: "redacted-correlation",
        level: "error",
        extra: { requestId: secret },
      },
      "2026-07-28T12:01:00.000Z",
    );

    expect(result).toMatchObject({
      accepted: true,
      event: { requestId: null },
    });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("applies byte-aware limits and records deterministic truncation reasons", () => {
    const result = normalizeEvent(
      {
        event_id: "event-3",
        level: "error",
        timestamp: "2026-07-28T12:00:00.000Z",
        message: "😀".repeat(1_025),
        exception: {
          values: [
            {
              type: "Error",
              value: "boom",
              stacktrace: {
                frames: Array.from({ length: 201 }, (_, number) => ({
                  filename: `file-${number}.ts`,
                })),
              },
            },
          ],
        },
        breadcrumbs: Array.from({ length: 101 }, (_, number) => ({
          message: `breadcrumb-${number}`,
        })),
        tags: Object.fromEntries(
          Array.from({ length: 101 }, (_, number) => [
            `tag-${number}`,
            "value",
          ]),
        ),
      },
      "2026-07-28T12:01:00.000Z",
    );

    expect(result).toMatchObject({ accepted: true });
    if (!result.accepted) {
      throw new Error("Expected accepted event");
    }
    expect(result.event.message).toBe("😀".repeat(1_024));
    expect(result.event.exception?.frames).toHaveLength(200);
    expect(result.event.breadcrumbs).toHaveLength(100);
    expect(result.event.truncated).toBe(true);
    expect(result.event.truncationReasons).toEqual([
      "tags",
      "exception_frames",
      "message_bytes",
      "breadcrumbs",
    ]);
  });

  it("never returns an unredacted persistence-facing payload", () => {
    const secret = "Bearer super-secret-token";
    const result = normalizeEvent(
      {
        event_id: "event-4",
        level: "error",
        timestamp: "2026-07-28T12:00:00.000Z",
        message: `failure ${secret}`,
        extra: { authorization: secret },
      },
      "2026-07-28T12:01:00.000Z",
    );

    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("redacts every sensitive fixture value from the entire normalized result", () => {
    const forbiddenValues = [
      "Bearer title-token",
      "Bearer exception-token",
      "Bearer breadcrumb-token",
      "sk_live_0123456789abcdef",
      "person@example.com",
      "private-preview",
      "url-token",
      "url-password",
      "Bearer metadata-token",
      "long-sensitive-tag-value",
    ];
    const result = normalizeEvent(
      {
        event_id: "event-4b",
        level: "error",
        timestamp: "2026-07-28T12:00:00.000Z",
        title: `failed ${forbiddenValues[0]}`,
        message: `failed ${forbiddenValues[4]}`,
        exception: {
          values: [{ type: "Error", value: forbiddenValues[1] }],
        },
        breadcrumbs: [{ message: forbiddenValues[2] }],
        tags: {
          apiKey: forbiddenValues[3],
          [`x`.repeat(220) + "Authentication"]: forbiddenValues[9],
        },
        contexts: {
          request: {
            url: `https://user:${forbiddenValues[7]}@example.test/orders?token=${forbiddenValues[6]}&page=2`,
            headers: {
              authorization: forbiddenValues[0],
              "x-request-id": "safe",
            },
          },
        },
        extra: { contentPreview: forbiddenValues[5] },
        release: forbiddenValues[8],
        environment: forbiddenValues[8],
        server_name: forbiddenValues[8],
        platform: forbiddenValues[8],
        logger: forbiddenValues[8],
      },
      "2026-07-28T12:01:00.000Z",
    );
    const serialized = JSON.stringify(result);

    for (const forbidden of forbiddenValues) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(serialized).not.toContain("contentPreview");
    expect(serialized).toContain("page=2");
    expect(serialized).toContain("x-request-id");
  });

  it("sanitizes request URLs even when no request headers are present", () => {
    const result = normalizeEvent(
      {
        event_id: "event-4c",
        level: "error",
        timestamp: "2026-07-28T12:00:00.000Z",
        contexts: {
          request: {
            url: "https://username:password@example.test/orders?access_token=hidden&page=2",
          },
        },
      },
      "2026-07-28T12:01:00.000Z",
    );

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("username");
    expect(serialized).not.toContain("password");
    expect(serialized).not.toContain("hidden");
    expect(serialized).toContain("page=2");
  });

  it("fails closed for relative and malformed request URLs", () => {
    const relative = normalizeEvent(
      {
        event_id: "relative-url",
        level: "error",
        contexts: { request: { url: "/orders?token=relative-secret&page=2" } },
      },
      "2026-07-28T12:01:00.000Z",
    );
    const malformed = normalizeEvent(
      {
        event_id: "malformed-url",
        level: "error",
        contexts: {
          request: {
            url: "http://user:password@[broken?api_key=malformed-secret&page=2",
          },
        },
      },
      "2026-07-28T12:01:00.000Z",
    );

    for (const serialized of [
      JSON.stringify(relative),
      JSON.stringify(malformed),
    ]) {
      expect(serialized).not.toContain("relative-secret");
      expect(serialized).not.toContain("malformed-secret");
      expect(serialized).not.toContain("password");
      expect(serialized).toContain("page=2");
    }
    expect(JSON.stringify(relative)).toContain("/orders?");
  });

  it.each(["requestId", "traceId", "taskId"] as const)(
    "hard-bounds an oversized multibyte %s within the serialized event cap",
    (field) => {
      const result = normalizeEvent(
        {
          event_id: `oversized-${field}`,
          level: "error",
          extra: { [field]: "😀".repeat(200_000) },
        },
        "2026-07-28T12:01:00.000Z",
      );

      expect(JSON.stringify(result)).not.toContain("😀".repeat(1_025));
      expect(
        new TextEncoder().encode(JSON.stringify(result)).byteLength,
      ).toBeLessThanOrEqual(512 * 1024);
    },
  );

  it("keeps only explicit bounded diagnostic shapes without duplicate context or extras", () => {
    const result = normalizeEvent(
      {
        event_id: "allowlists",
        level: "error",
        exception: {
          values: [
            {
              type: "Error",
              value: "failure",
              ignored: "exception-secret",
              stacktrace: {
                frames: [
                  {
                    filename: "app.ts",
                    function: "run",
                    ignored: "frame-secret",
                  },
                ],
              },
            },
          ],
        },
        breadcrumbs: [
          {
            category: "http",
            message: "request",
            ignored: "breadcrumb-secret",
          },
        ],
        contexts: {
          request: {
            method: "GET",
            url: "/safe?page=2",
            ignored: "request-secret",
          },
          runtime: { name: "node", version: "22", ignored: "runtime-secret" },
          ignoredContext: { value: "context-secret" },
        },
        extra: {
          requestId: "request-1",
          code: "EFAIL",
          ignored: "extra-secret",
        },
      },
      "2026-07-28T12:01:00.000Z",
    );

    expect(result).toMatchObject({ accepted: true });
    expect(JSON.stringify(result)).not.toContain("-secret");
    if (!result.accepted) {
      throw new Error("Expected accepted event");
    }
    expect(result.event).not.toHaveProperty("contexts");
    expect(result.event).not.toHaveProperty("extras");
    expect(result.event.payload).toMatchObject({
      contexts: {
        request: { method: "GET" },
        runtime: { name: "node", version: "22" },
      },
      extras: { requestId: "request-1", code: "EFAIL" },
    });
  });

  it("reports recursion-depth truncation in event metadata", () => {
    const result = normalizeEvent(
      {
        event_id: "deep-event",
        level: "error",
        extra: nest("deep-secret", 9),
      },
      "2026-07-28T12:01:00.000Z",
    );

    expect(result).toMatchObject({
      accepted: true,
      event: {
        truncated: true,
        truncationReasons: ["recursion_depth"],
      },
    });
    if (!result.accepted) {
      throw new Error("Expected accepted event");
    }
    expect(JSON.stringify(result.event.payload.extras)).toContain(
      "recursion_depth",
    );
  });

  it("selects the first meaningful exception and reports discarded chain evidence", () => {
    const result = normalizeEvent(
      {
        event_id: "exception-chain",
        level: "error",
        exception: {
          values: [
            {},
            {
              type: "CauseError",
              value: "root cause",
              stacktrace: { frames: [{ filename: "cause.ts" }] },
            },
            { type: "OuterError", value: "outer cause" },
          ],
        },
      },
      "2026-07-28T12:01:00.000Z",
    );

    expect(result).toMatchObject({
      accepted: true,
      event: {
        exception: {
          type: "CauseError",
          value: "root cause",
          discardedValues: 1,
        },
        truncated: true,
        truncationReasons: ["exception_chain"],
      },
    });
  });

  it("retains exactly the code-point-sorted first 100 tags and avoids truncated-key collisions", () => {
    const tags = Object.fromEntries(
      Array.from({ length: 101 }, (_, index) => [
        `tag-${String(index).padStart(3, "0")}`,
        String(index),
      ]),
    );
    tags[`${"a".repeat(200)}A`] = "first";
    tags[`${"a".repeat(200)}B`] = "second";
    const result = normalizeEvent(
      { event_id: "tag-boundary", level: "error", tags },
      "2026-07-28T12:01:00.000Z",
    );

    expect(result).toMatchObject({ accepted: true });
    if (!result.accepted) {
      throw new Error("Expected accepted event");
    }
    expect(Object.keys(result.event.tags)).toHaveLength(100);
    expect(result.event.tags["tag-100"]).toBeUndefined();
    expect(result.event.tags["a".repeat(200)]).toBe("first");
  });

  it("bounds the serialized normalized event to 512 KiB", () => {
    const result = normalizeEvent(
      {
        event_id: "event-5",
        level: "error",
        timestamp: "2026-07-28T12:00:00.000Z",
        message: "failure",
        extra: { diagnosticDump: "x".repeat(600 * 1024) },
      },
      "2026-07-28T12:01:00.000Z",
    );

    expect(
      new TextEncoder().encode(JSON.stringify(result)).byteLength,
    ).toBeLessThanOrEqual(512 * 1024);
    expect(result).toMatchObject({ accepted: true });
  });
});

function nest(value: string, depth: number): Record<string, unknown> {
  let current: Record<string, unknown> = { value };
  for (let index = 0; index < depth; index += 1) {
    current = { nested: current };
  }
  return current;
}

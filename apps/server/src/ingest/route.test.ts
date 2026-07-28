import { randomBytes } from "node:crypto";
import { gzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { MAX_DECOMPRESSED_ENVELOPE_BYTES } from "@intexura-error-hub/protocol";
import { openDatabase, type ErrorHubDatabase } from "../storage/database.js";
import { EventRepository } from "../storage/event-repository.js";
import { IssueRepository } from "../storage/issue-repository.js";
import { migrateDatabase } from "../storage/migrate.js";
import type { OutboxDraft } from "../storage/outbox-repository.js";
import { ProjectRepository } from "../storage/project-repository.js";
import { createPublicApp, type PublicAppOptions } from "../public-app.js";
import { ErrorHubMetrics } from "../metrics.js";
import {
  DEFAULT_RETENTION_CONFIG,
  StorageSafetyState,
} from "../retention/storage-budget.js";
import type {
  ShadowForwardRequest,
  ShadowForwarder,
} from "./shadow-forwarder.js";

const NODE_FIXTURE = readFileSync(
  new URL(
    "../../../../packages/protocol/test/fixtures/node-event.envelope",
    import.meta.url,
  ),
);
const FIXTURE_EVENT_ID = "11111111111111111111111111111111";
const PUBLIC_KEY = "fixture-public-key";
const PROD_KEY = "prod-public-key";
const OTHER_KEY = "other-public-key";
const RECEIVED_AT = "2026-07-28T12:00:00.000Z";
const ALLOWED_ORIGIN = "https://app.intexuraos.cloud";

const openApplications: FastifyInstance[] = [];
const openDatabases: ErrorHubDatabase[] = [];

afterEach(async () => {
  for (const app of openApplications.splice(0).reverse()) {
    await app.close();
  }
  for (const database of openDatabases.splice(0).reverse()) {
    if (database.open) database.close();
  }
});

describe("public Sentry envelope ingest", () => {
  it("stores an actual Sentry Node 8.55 envelope through the exact write-only path", async () => {
    const fixture = createFixture();

    const response = await postEnvelope(fixture.app, NODE_FIXTURE);

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/json");
    expect(response.json()).toEqual({ id: FIXTURE_EVENT_ID });
    const stored = fixture.events.getByProjectAndEventId(1, FIXTURE_EVENT_ID);
    expect(stored).toMatchObject({
      projectId: 1,
      eventId: FIXTURE_EVENT_ID,
      release: "fixture-node@1.0.0",
      environment: "fixture",
      service: "fixture-host",
      level: "error",
    });
    expect(stored?.payload.platform).toBe("node");
    expect(fixture.issues.getById(stored?.issueId ?? -1)).toMatchObject({
      occurrenceCount: 1,
    });
    expect(projectSlug(fixture.database, stored?.projectId ?? -1)).toBe(
      "intexuraos-backend",
    );
  });

  it("registers only ingest, OPTIONS, and minimal liveness on the public listener", async () => {
    const fixture = createFixture();

    expect(
      await fixture.app.inject({ method: "GET", url: "/api/issues" }),
    ).toMatchObject({ statusCode: 404 });
    expect(
      await fixture.app.inject({ method: "GET", url: "/api/export" }),
    ).toMatchObject({ statusCode: 404 });
    expect(
      await fixture.app.inject({ method: "GET", url: "/metrics" }),
    ).toMatchObject({ statusCode: 404 });
    expect(await fixture.app.inject({ method: "GET", url: "/" })).toMatchObject(
      { statusCode: 404 },
    );
    expect(
      await fixture.app.inject({ method: "GET", url: "/health/live" }),
    ).toMatchObject({ statusCode: 200 });
  });

  it("accepts standard X-Sentry-Auth when sentry_key is absent", async () => {
    const fixture = createFixture();
    const response = await fixture.app.inject({
      method: "POST",
      url: "/api/1/envelope/?sentry_version=7",
      headers: {
        "x-sentry-auth":
          "Sentry sentry_version=7, sentry_client=sentry.javascript.node%2F8.55.0, sentry_key=fixture-public-key",
      },
      payload: NODE_FIXTURE,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ id: FIXTURE_EVENT_ID });
  });

  it.each([
    {
      name: "unknown project",
      url: `/api/999/envelope/?sentry_key=${PUBLIC_KEY}`,
    },
    {
      name: "key from a different project",
      url: `/api/1/envelope/?sentry_key=${OTHER_KEY}`,
    },
    {
      name: "non-numeric project",
      url: `/api/project/envelope/?sentry_key=${PUBLIC_KEY}`,
    },
    {
      name: "missing key",
      url: "/api/1/envelope/",
    },
    {
      name: "conflicting query and header keys",
      url: `/api/1/envelope/?sentry_key=${PUBLIC_KEY}`,
      auth: "Sentry sentry_version=7, sentry_key=other-public-key, sentry_client=test",
    },
  ])(
    "rejects $name without persistence or forwarding",
    async ({ url, auth }) => {
      const fixture = createFixture();
      const response = await fixture.app.inject({
        method: "POST",
        url,
        headers: auth === undefined ? {} : { "x-sentry-auth": auth },
        payload: NODE_FIXTURE,
      });

      expectSentryError(response, 400);
      expect(count(fixture.database, "events")).toBe(0);
      expect(count(fixture.database, "webhook_outbox")).toBe(0);
      expect(fixture.forwarded).toEqual([]);
      expect(response.body).not.toContain("999");
      expect(response.body).not.toContain(PUBLIC_KEY);
      expect(response.body).not.toContain(OTHER_KEY);
    },
  );

  it("rejects a valid key for a disabled project before every side effect", async () => {
    const fixture = createFixture({ projectEnabled: false });

    const response = await postEnvelope(fixture.app, NODE_FIXTURE);

    expectSentryError(response, 400);
    expect(count(fixture.database, "events")).toBe(0);
    expect(count(fixture.database, "webhook_outbox")).toBe(0);
    expect(fixture.forwarded).toEqual([]);
  });

  it("rejects an event environment not bound to the verified key before every side effect", async () => {
    const fixture = createFixture({
      forwardingMode: "shadow",
      forwardingSecretRef: "LEGACY_FIXTURE_DSN",
    });
    const envelope = eventEnvelope({
      event_id: eventId(2),
      environment: "prod",
      level: "error",
      message: "wrong environment",
    });

    const response = await postEnvelope(fixture.app, envelope);

    expectSentryError(response, 400);
    expect(count(fixture.database, "events")).toBe(0);
    expect(count(fixture.database, "webhook_outbox")).toBe(0);
    expect(fixture.forwarded).toEqual([]);
  });

  it("validates every event environment before persisting any item from a multi-event envelope", async () => {
    const fixture = createFixture({
      forwardingMode: "shadow",
      forwardingSecretRef: "LEGACY_FIXTURE_DSN",
    });
    const envelope = envelopeWithItems(eventId(3), [
      {
        type: "event",
        payload: {
          event_id: eventId(3),
          environment: "fixture",
          level: "error",
          message: "valid first item",
        },
      },
      {
        type: "event",
        payload: {
          event_id: eventId(4),
          environment: "prod",
          level: "fatal",
          message: "invalid second item",
        },
      },
    ]);

    const response = await postEnvelope(fixture.app, envelope);

    expectSentryError(response, 400);
    expect(count(fixture.database, "events")).toBe(0);
    expect(count(fixture.database, "webhook_outbox")).toBe(0);
    expect(fixture.forwarded).toEqual([]);
  });

  it("allows only exact configured browser origins and emits complete preflight headers", async () => {
    const fixture = createFixture();
    const allowed = await postEnvelope(fixture.app, NODE_FIXTURE, {
      origin: ALLOWED_ORIGIN,
    });
    const preflight = await fixture.app.inject({
      method: "OPTIONS",
      url: `/api/1/envelope/?sentry_version=7&sentry_key=${PUBLIC_KEY}`,
      headers: {
        origin: ALLOWED_ORIGIN,
        "access-control-request-method": "POST",
        "access-control-request-headers":
          "content-type,content-encoding,x-sentry-auth",
      },
    });

    expect(allowed.statusCode).toBe(200);
    expect(allowed.headers["access-control-allow-origin"]).toBe(ALLOWED_ORIGIN);
    expect(allowed.headers.vary).toContain("Origin");
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers["access-control-allow-origin"]).toBe(
      ALLOWED_ORIGIN,
    );
    expect(preflight.headers["access-control-allow-methods"]).toBe(
      "POST, OPTIONS",
    );
    expect(preflight.headers["access-control-allow-headers"]).toBe(
      "Content-Type, Content-Encoding, X-Sentry-Auth",
    );
  });

  it("rejects a lookalike browser origin before storage or forwarding", async () => {
    const fixture = createFixture();

    const response = await postEnvelope(fixture.app, NODE_FIXTURE, {
      origin: `${ALLOWED_ORIGIN}.attacker.example`,
    });

    expectSentryError(response, 400);
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
    expect(count(fixture.database, "events")).toBe(0);
    expect(fixture.forwarded).toEqual([]);
  });

  it("decompresses gzip envelopes before protocol parsing", async () => {
    const fixture = createFixture();

    const response = await postEnvelope(fixture.app, gzipSync(NODE_FIXTURE), {
      "content-encoding": "gzip",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ id: FIXTURE_EVENT_ID });
    expect(
      fixture.events.getByProjectAndEventId(1, FIXTURE_EVENT_ID),
    ).not.toBeNull();
  });

  it.each([
    ["warning", true, "warn"],
    ["warn", true, "warn"],
    ["error", true, "error"],
    ["fatal", true, "fatal"],
    ["trace", false, null],
    ["debug", false, null],
    ["info", false, null],
    ["notice", false, null],
  ] as const)(
    "acknowledges level %s and persists it only when admitted",
    async (level, persisted, canonicalLevel) => {
      const fixture = createFixture();
      const id = eventId(level.length + (persisted ? 20 : 40));

      const response = await postEnvelope(
        fixture.app,
        eventEnvelope({
          event_id: id,
          environment: "fixture",
          level,
          message: `level ${level}`,
        }),
      );

      expect(response.statusCode).toBe(200);
      const stored = fixture.events.getByProjectAndEventId(1, id);
      if (persisted) {
        expect(stored?.level).toBe(canonicalLevel);
      } else {
        expect(stored).toBeNull();
        expect(count(fixture.database, "webhook_outbox")).toBe(0);
      }
    },
  );

  it("canonicalizes a missing level with a non-empty exception to error", async () => {
    const fixture = createFixture();
    const id = eventId(50);
    const response = await postEnvelope(
      fixture.app,
      eventEnvelope({
        event_id: id,
        environment: "fixture",
        exception: { values: [{ type: "TypeError", value: "boom" }] },
      }),
    );

    expect(response.statusCode).toBe(200);
    expect(fixture.events.getByProjectAndEventId(1, id)?.level).toBe("error");
  });

  it("acknowledges unsupported and unknown items without persistence or retry pressure", async () => {
    const fixture = createFixture();
    const id = eventId(60);
    const envelope = envelopeWithItems(
      id,
      [
        "transaction",
        "span",
        "session",
        "sessions",
        "client_report",
        "unknown_item",
      ].map((type) => ({ type, payload: { discarded: true } })),
    );

    const response = await postEnvelope(fixture.app, envelope);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ id });
    expect(count(fixture.database, "events")).toBe(0);
    expect(count(fixture.database, "webhook_outbox")).toBe(0);
  });

  it.each([
    { type: "attachment", contentType: "application/octet-stream" },
    { type: "profile_chunk", contentType: "application/octet-stream" },
  ])(
    "rejects binary $type items at the boundary without storing any preceding event",
    async ({ type, contentType }) => {
      const fixture = createFixture();
      const id = eventId(type.length + 90);
      const event = Buffer.from(
        JSON.stringify({
          event_id: id,
          environment: "fixture",
          level: "error",
          message: "must roll back before binary item",
        }),
      );
      const binary = Buffer.from([0, 1, 2, 3]);
      const envelope = Buffer.concat([
        Buffer.from(`${JSON.stringify({ event_id: id })}\n`),
        Buffer.from(
          `${JSON.stringify({ type: "event", length: event.length })}\n`,
        ),
        event,
        Buffer.from("\n"),
        Buffer.from(
          `${JSON.stringify({
            type,
            length: binary.length,
            content_type: contentType,
          })}\n`,
        ),
        binary,
      ]);

      const response = await postEnvelope(fixture.app, envelope);

      expectSentryError(response, 400);
      expect(count(fixture.database, "events")).toBe(0);
      expect(count(fixture.database, "webhook_outbox")).toBe(0);
    },
  );

  it("keeps retries with the same event ID idempotent", async () => {
    const fixture = createFixture();
    const id = eventId(70);
    const envelope = eventEnvelope({
      event_id: id,
      environment: "fixture",
      release: "release-1",
      server_name: "api",
      level: "error",
      message: "same retry",
    });

    expect((await postEnvelope(fixture.app, envelope)).statusCode).toBe(200);
    expect((await postEnvelope(fixture.app, envelope)).statusCode).toBe(200);

    const stored = fixture.events.getByProjectAndEventId(1, id);
    expect(stored).not.toBeNull();
    expect(fixture.issues.getById(stored?.issueId ?? -1)).toMatchObject({
      occurrenceCount: 1,
    });
    expect(count(fixture.database, "events")).toBe(1);
    expect(count(fixture.database, "webhook_outbox")).toBe(1);
  });

  it("returns a bounded Sentry 400 surface for malformed envelopes and event IDs", async () => {
    const fixture = createFixture();
    const malformed = await postEnvelope(fixture.app, Buffer.from("{bad"));
    const mismatched = await postEnvelope(
      fixture.app,
      envelopeWithItems(eventId(80), [
        {
          type: "event",
          payload: {
            event_id: eventId(81),
            environment: "fixture",
            level: "error",
            message: "mismatch",
          },
        },
      ]),
    );

    expectSentryError(malformed, 400);
    expectSentryError(mismatched, 400);
    expect(malformed.body.length).toBeLessThan(1_024);
    expect(mismatched.body.length).toBeLessThan(1_024);
    expect(count(fixture.database, "events")).toBe(0);
  });

  it.each([
    ["empty envelope ID", "", eventId(82)],
    ["empty payload ID", eventId(82), ""],
    ["short envelope ID", "abc", "abc"],
    ["non-hex payload ID", "g".repeat(32), "g".repeat(32)],
    ["oversized envelope ID", "a".repeat(33), "a".repeat(33)],
    ["mismatched valid IDs", eventId(82), eventId(83)],
  ])(
    "rejects %s before every side effect",
    async (_name, envelopeId, payloadId) => {
      const fixture = createFixture({
        forwardingMode: "shadow",
        forwardingSecretRef: "LEGACY_FIXTURE_DSN",
      });
      const response = await postEnvelope(
        fixture.app,
        envelopeWithItems(envelopeId, [
          {
            type: "event",
            payload: {
              event_id: payloadId,
              environment: "fixture",
              level: "error",
              message: "invalid event id",
            },
          },
        ]),
      );

      expectSentryError(response, 400);
      expect(count(fixture.database, "events")).toBe(0);
      expect(count(fixture.database, "webhook_outbox")).toBe(0);
      expect(fixture.forwarded).toEqual([]);
    },
  );

  it("canonicalizes valid uppercase event IDs before equality and persistence", async () => {
    const fixture = createFixture();
    const lowercase = "abcdef0123456789abcdef0123456789";
    const response = await postEnvelope(
      fixture.app,
      envelopeWithItems(lowercase.toUpperCase(), [
        {
          type: "event",
          payload: {
            event_id: lowercase,
            environment: "fixture",
            level: "error",
            message: "canonical id",
          },
        },
      ]),
    );

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ id: lowercase });
    expect(fixture.events.getByProjectAndEventId(1, lowercase)).not.toBeNull();
  });

  it("returns Sentry 413 for identity and gzip bodies above the decompressed limit", async () => {
    const fixture = createFixture();
    const identity = await postEnvelope(
      fixture.app,
      Buffer.alloc(MAX_DECOMPRESSED_ENVELOPE_BYTES + 1, 0x61),
    );
    const gzip = await postEnvelope(
      fixture.app,
      gzipSync(Buffer.alloc(MAX_DECOMPRESSED_ENVELOPE_BYTES + 1, 0x61)),
      { "content-encoding": "gzip" },
    );

    expectSentryError(identity, 413);
    expectSentryError(gzip, 413);
    expect(count(fixture.database, "events")).toBe(0);
  });

  it("allows bounded gzip framing overhead while retaining the exact decompressed cap", async () => {
    const itemHeader = Buffer.from(
      `${JSON.stringify({ type: "unknown_item", length: 1_048_480 })}\n`,
    );
    const envelope = Buffer.concat([
      Buffer.from("{}\n"),
      itemHeader,
      randomBytes(1_048_480),
    ]);
    const compressed = gzipSync(envelope, { level: 0 });
    expect(envelope.byteLength).toBeLessThanOrEqual(
      MAX_DECOMPRESSED_ENVELOPE_BYTES,
    );
    expect(compressed.byteLength).toBeGreaterThan(
      MAX_DECOMPRESSED_ENVELOPE_BYTES,
    );

    const fixture = createFixture();
    const response = await postEnvelope(fixture.app, compressed, {
      "content-encoding": "gzip",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ id: "" });
  });

  it("never reflects an unsupported Content-Encoding value", async () => {
    const supplied = "attacker-controlled-encoding-with-private-data";
    const fixture = createFixture();
    const response = await postEnvelope(fixture.app, NODE_FIXTURE, {
      "content-encoding": supplied,
    });

    expectSentryError(response, 400);
    expect(response.headers["x-sentry-error"]).toBe(
      "Unsupported Content-Encoding.",
    );
    expect(response.body).not.toContain(supplied);
  });

  it("returns 429 with Retry-After when either source or project budget is exhausted", async () => {
    const sourceFixture = createFixture({
      limits: { sourceRateLimit: 1, projectRateLimit: 10 },
    });
    expect(
      (await postEnvelope(sourceFixture.app, NODE_FIXTURE)).statusCode,
    ).toBe(200);
    const sourceLimited = await postEnvelope(sourceFixture.app, NODE_FIXTURE);
    expectSentryError(sourceLimited, 429);
    expect(sourceLimited.headers["retry-after"]).toBe("60");

    const projectFixture = createFixture({
      limits: { sourceRateLimit: 10, projectRateLimit: 1 },
    });
    expect(
      (await postEnvelope(projectFixture.app, NODE_FIXTURE)).statusCode,
    ).toBe(200);
    const projectLimited = await postEnvelope(projectFixture.app, NODE_FIXTURE);
    expectSentryError(projectLimited, 429);
    expect(projectLimited.headers["retry-after"]).toBe("60");
  });

  it("bounds concurrent decompression and parsing work", async () => {
    const fixture = createFixture({
      limits: {
        sourceRateLimit: 10,
        projectRateLimit: 10,
        maxConcurrentParses: 1,
      },
    });
    const secondEnvelope = eventEnvelope({
      event_id: eventId(88),
      environment: "fixture",
      level: "error",
      message: "concurrent envelope",
    });

    const [first, second] = await Promise.all([
      postEnvelope(fixture.app, gzipSync(NODE_FIXTURE), {
        "content-encoding": "gzip",
      }),
      postEnvelope(fixture.app, gzipSync(secondEnvelope), {
        "content-encoding": "gzip",
      }),
    ]);

    expect([first.statusCode, second.statusCode].sort()).toEqual([200, 429]);
    const limited = first.statusCode === 429 ? first : second;
    expect(limited.headers["x-sentry-error"]).toBe(
      "Concurrent ingest limit exceeded.",
    );
    expect(limited.headers["retry-after"]).toBe("60");
  });

  it("does not let an invalid key consume the verified project's rate budget", async () => {
    const fixture = createFixture({
      limits: { sourceRateLimit: 10, projectRateLimit: 1 },
    });
    const rejected = await fixture.app.inject({
      method: "POST",
      url: `/api/1/envelope/?sentry_key=${OTHER_KEY}`,
      payload: NODE_FIXTURE,
    });

    expectSentryError(rejected, 400);
    expect((await postEnvelope(fixture.app, NODE_FIXTURE)).statusCode).toBe(
      200,
    );
  });

  it.each([
    {
      name: "wrong environment",
      invalidKey: PUBLIC_KEY,
      invalidOrigin: undefined,
      invalidBody: eventEnvelope({
        event_id: eventId(84),
        environment: "prod",
        level: "error",
        message: "wrong environment",
      }),
      validKey: PROD_KEY,
      validEnvironment: "prod",
    },
    {
      name: "disallowed origin",
      invalidKey: PROD_KEY,
      invalidOrigin: "https://attacker.example",
      invalidBody: eventEnvelope({
        event_id: eventId(85),
        environment: "prod",
        level: "error",
        message: "origin",
      }),
      validKey: PUBLIC_KEY,
      validEnvironment: "fixture",
    },
    {
      name: "malformed envelope",
      invalidKey: PUBLIC_KEY,
      invalidOrigin: undefined,
      invalidBody: Buffer.from("{malformed"),
      validKey: PROD_KEY,
      validEnvironment: "prod",
    },
    {
      name: "binary envelope item",
      invalidKey: PROD_KEY,
      invalidOrigin: undefined,
      invalidBody: binaryEnvelope(eventId(86), "prod"),
      validKey: PUBLIC_KEY,
      validEnvironment: "fixture",
    },
  ])(
    "does not charge the shared project budget for $name",
    async ({
      invalidKey,
      invalidOrigin,
      invalidBody,
      validKey,
      validEnvironment,
    }) => {
      const fixture = createFixture({
        limits: {
          globalRateLimit: 20,
          sourceRateLimit: 20,
          projectRateLimit: 1,
        },
      });
      const rejected = await postEnvelopeWithKey(
        fixture.app,
        invalidKey,
        invalidBody,
        invalidOrigin === undefined ? {} : { origin: invalidOrigin },
      );
      expectSentryError(rejected, 400);

      const acceptedId = eventId(validEnvironment === "prod" ? 87 : 88);
      const accepted = await postEnvelopeWithKey(
        fixture.app,
        validKey,
        eventEnvelope({
          event_id: acceptedId,
          environment: validEnvironment,
          level: "error",
          message: "valid after rejected request",
        }),
      );
      expect(accepted.statusCode).toBe(200);
      expect(
        fixture.events.getByProjectAndEventId(1, acceptedId),
      ).not.toBeNull();
    },
  );

  it("bounds OPTIONS and rejects a limited source before parsing an oversized body", async () => {
    const fixture = createFixture({
      limits: { globalRateLimit: 10, sourceRateLimit: 1, projectRateLimit: 10 },
    });
    const url = `/api/1/envelope/?sentry_key=${PUBLIC_KEY}`;
    const preflight = await fixture.app.inject({ method: "OPTIONS", url });
    expect(preflight.statusCode).toBe(204);

    const rejectedPreflight = await fixture.app.inject({
      method: "OPTIONS",
      url,
    });
    expectSentryError(rejectedPreflight, 429);

    const oversized = await fixture.app.inject({
      method: "POST",
      url,
      payload: Buffer.alloc(MAX_DECOMPRESSED_ENVELOPE_BYTES + 100_000),
    });
    expectSentryError(oversized, 429);
  });

  it("applies the global admission budget across distinct proxy sources", async () => {
    const fixture = createFixture({
      limits: { globalRateLimit: 1, sourceRateLimit: 10, projectRateLimit: 10 },
    });
    const url = `/api/1/envelope/?sentry_key=${PUBLIC_KEY}`;
    const first = await fixture.app.inject({
      method: "OPTIONS",
      url,
      headers: { "x-forwarded-for": "198.51.100.10" },
    });
    const second = await fixture.app.inject({
      method: "OPTIONS",
      url,
      headers: { "x-forwarded-for": "198.51.100.11" },
    });

    expect(first.statusCode).toBe(204);
    expectSentryError(second, 429);
  });

  it("keeps source budgets independent behind the trusted loopback proxy", async () => {
    const fixture = createFixture({
      limits: { sourceRateLimit: 1, projectRateLimit: 10 },
    });
    const first = await postEnvelope(fixture.app, NODE_FIXTURE, {
      "x-forwarded-for": "198.51.100.10",
    });
    const second = await postEnvelope(
      fixture.app,
      eventEnvelope({
        event_id: eventId(89),
        environment: "fixture",
        level: "error",
        message: "second source",
      }),
      { "x-forwarded-for": "198.51.100.11" },
    );

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
  });

  it("acknowledges an unsupported-only envelope without an event ID", async () => {
    const fixture = createFixture();
    const payload = Buffer.from('{"reason":"network_error"}');
    const envelope = Buffer.concat([
      Buffer.from("{}\n"),
      Buffer.from(
        `${JSON.stringify({ type: "client_report", length: payload.length })}\n`,
      ),
      payload,
    ]);

    const response = await postEnvelope(fixture.app, envelope);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ id: "" });
    expect(count(fixture.database, "events")).toBe(0);
    expect(count(fixture.database, "webhook_outbox")).toBe(0);
  });

  it("records accepted, unsupported discard, rejected, parse, and grouping outcomes with fixed labels", async () => {
    const fixture = createFixture();
    await postEnvelope(fixture.app, NODE_FIXTURE);
    const unsupportedPayload = Buffer.from('{"reason":"network_error"}');
    await postEnvelope(
      fixture.app,
      Buffer.concat([
        Buffer.from("{}\n"),
        Buffer.from(
          `${JSON.stringify({ type: "client_report", length: unsupportedPayload.length })}\n`,
        ),
        unsupportedPayload,
      ]),
    );
    await fixture.app.inject({
      method: "POST",
      url: "/api/999/envelope/?sentry_key=wrong",
      payload: NODE_FIXTURE,
    });
    const storage = new StorageSafetyState(DEFAULT_RETENTION_CONFIG);
    storage.observeUsage(
      {
        databaseBytes: 0,
        walBytes: 0,
        shmBytes: 0,
        temporaryBytes: 0,
        dataDirectoryOtherBytes: 0,
        totalBytes: 0,
        freeBytes: 1024 ** 3,
      },
      0,
      null,
    );
    const rendered = fixture.metrics.render({
      database: fixture.database,
      storage,
    });

    expect(rendered).toContain(
      'error_hub_ingest_events_total{outcome="accepted"} 1',
    );
    expect(rendered).toContain(
      'error_hub_ingest_events_total{outcome="discarded"} 1',
    );
    expect(rendered).toContain(
      'error_hub_ingest_events_total{outcome="rejected"} 1',
    );
    expect(rendered).toContain('error_hub_grouping_total{outcome="created"} 1');
    expect(rendered).toContain("error_hub_parse_duration_seconds_count 2");
  });

  it("returns 503 only when storage safety marks ingest unavailable", async () => {
    const storageSafety = new StorageSafetyState(DEFAULT_RETENTION_CONFIG);
    storageSafety.markFailure(
      "physical_storage_critical",
      new Date(RECEIVED_AT),
    );
    const fixture = createFixture({ storageSafety });

    const response = await postEnvelope(fixture.app, NODE_FIXTURE);

    expectSentryError(response, 503);
    expect(response.headers["retry-after"]).toBe("60");
    expect(count(fixture.database, "events")).toBe(0);
    expect(fixture.forwarded).toEqual([]);
  });

  it("fails closed with a bounded retryable 503 before storage safety has a successful sample", async () => {
    const fixture = createFixture({ storageInitiallyUnknown: true });

    const response = await postEnvelope(fixture.app, NODE_FIXTURE);

    expectSentryError(response, 503);
    expect(response.headers["retry-after"]).toBe("60");
  });

  it("maps unexpected internal failures to a bounded retryable 500", async () => {
    const fixture = createFixture({
      now() {
        throw new Error("private clock failure");
      },
    });

    const response = await postEnvelope(fixture.app, NODE_FIXTURE);

    expectSentryError(response, 500);
    expect(response.headers["retry-after"]).toBe("60");
    expect(response.headers["x-sentry-error"]).toBe("Internal ingest failure.");
    expect(response.body).not.toContain("private clock failure");
  });

  it("releases early concurrency admission after an unexpected handler error", async () => {
    let requestNumber = 0;
    const fixture = createFixture({
      limits: {
        globalRateLimit: 10,
        sourceRateLimit: 10,
        projectRateLimit: 10,
        maxConcurrentParses: 1,
      },
      now() {
        requestNumber += 1;
        if (requestNumber > 1) return new Date(RECEIVED_AT);
        const invalidDate = new Date(RECEIVED_AT);
        invalidDate.toISOString = () => {
          throw new Error("private timestamp failure");
        };
        return invalidDate;
      },
    });

    const failed = await postEnvelope(fixture.app, NODE_FIXTURE);
    const accepted = await postEnvelope(fixture.app, NODE_FIXTURE);

    expectSentryError(failed, 500);
    expect(accepted.statusCode).toBe(200);
  });

  it("returns a bounded 503 when project credential storage cannot be read", async () => {
    const fixture = createFixture();
    fixture.database.close();

    const response = await postEnvelope(fixture.app, NODE_FIXTURE);

    expectSentryError(response, 503);
    expect(response.headers["retry-after"]).toBe("60");
    expect(response.body).not.toContain("database");
    expect(response.body).not.toContain("SQLite");
    expect(fixture.forwarded).toEqual([]);
  });

  it("enqueues shadow forwarding only after validation and storage without affecting 200", async () => {
    const fixture = createFixture({
      forwardingMode: "shadow",
      forwardingSecretRef: "LEGACY_FIXTURE_DSN",
      shadowResult: "saturated",
    });

    const response = await postEnvelope(fixture.app, NODE_FIXTURE);

    expect(response.statusCode).toBe(200);
    expect(fixture.forwarded).toHaveLength(1);
    expect(fixture.forwarded[0]).toMatchObject({
      eventEnvironment: "fixture",
      contentEncoding: undefined,
    });
    expect(fixture.forwarded[0]?.envelope).toEqual(NODE_FIXTURE);
    expect(
      fixture.events.getByProjectAndEventId(1, FIXTURE_EVENT_ID),
    ).not.toBeNull();
  });

  it("keeps the SDK response successful when shadow enqueue throws after commit", async () => {
    const fixture = createFixture({
      forwardingMode: "shadow",
      forwardingSecretRef: "LEGACY_FIXTURE_DSN",
      shadowThrows: true,
    });

    const response = await postEnvelope(fixture.app, NODE_FIXTURE);

    expect(response.statusCode).toBe(200);
    expect(
      fixture.events.getByProjectAndEventId(1, FIXTURE_EVENT_ID),
    ).not.toBeNull();
    expect(fixture.operationalMetrics).toEqual([
      { type: "shadow_enqueue_failure" },
    ]);
  });
});

interface FixtureOptions {
  readonly projectEnabled?: boolean;
  readonly forwardingMode?: "disabled" | "shadow";
  readonly forwardingSecretRef?: string | null;
  readonly shadowResult?: ReturnType<ShadowForwarder["enqueue"]>;
  readonly shadowThrows?: boolean;
  readonly storageSafety?: StorageSafetyState;
  readonly storageInitiallyUnknown?: boolean;
  readonly now?: () => Date;
  readonly limits?: PublicAppOptions["limits"];
}

function createFixture(options: FixtureOptions = {}): {
  readonly app: FastifyInstance;
  readonly database: ErrorHubDatabase;
  readonly events: EventRepository;
  readonly issues: IssueRepository;
  readonly forwarded: ShadowForwardRequest[];
  readonly operationalMetrics: { readonly type: string }[];
  readonly metrics: ErrorHubMetrics;
} {
  const database = openDatabase(":memory:");
  openDatabases.push(database);
  migrateDatabase(database, RECEIVED_AT);
  const projects = new ProjectRepository(database);
  projects.create({
    id: 1,
    slug: "intexuraos-backend",
    name: "IntexuraOS Backend",
    enabled: options.projectEnabled ?? true,
    createdAt: RECEIVED_AT,
  });
  projects.create({
    id: 2,
    slug: "another-project",
    name: "Another Project",
    enabled: true,
    createdAt: RECEIVED_AT,
  });
  projects.setIngestKey({
    projectId: 1,
    environment: "fixture",
    publicKey: PUBLIC_KEY,
    allowedOrigins: [ALLOWED_ORIGIN],
    forwardingMode: options.forwardingMode ?? "disabled",
    forwardingSecretRef: options.forwardingSecretRef ?? null,
    webhookMode: "disabled",
    webhookTargetUrl: null,
    webhookSecretRef: null,
    enabledAt: null,
  });
  projects.setIngestKey({
    projectId: 1,
    environment: "prod",
    publicKey: PROD_KEY,
    allowedOrigins: [ALLOWED_ORIGIN],
    forwardingMode: "disabled",
    forwardingSecretRef: null,
    webhookMode: "disabled",
    webhookTargetUrl: null,
    webhookSecretRef: null,
    enabledAt: null,
  });
  projects.setIngestKey({
    projectId: 2,
    environment: "fixture",
    publicKey: OTHER_KEY,
    allowedOrigins: [],
    forwardingMode: "disabled",
    forwardingSecretRef: null,
    webhookMode: "disabled",
    webhookTargetUrl: null,
    webhookSecretRef: null,
    enabledAt: null,
  });

  const forwarded: ShadowForwardRequest[] = [];
  const shadowForwarder: ShadowForwarder = {
    enqueue(request) {
      forwarded.push(request);
      if (options.shadowThrows === true) {
        throw new Error("private shadow queue failure");
      }
      return options.shadowResult ?? "disabled";
    },
  };
  const operationalMetrics: { readonly type: string }[] = [];
  const metrics = new ErrorHubMetrics();
  const storageSafety =
    options.storageSafety ?? new StorageSafetyState(DEFAULT_RETENTION_CONFIG);
  if (
    options.storageSafety === undefined &&
    options.storageInitiallyUnknown !== true
  ) {
    storageSafety.observeUsage(
      {
        databaseBytes: 0,
        walBytes: 0,
        shmBytes: 0,
        temporaryBytes: 0,
        dataDirectoryOtherBytes: 0,
        totalBytes: 0,
        freeBytes: 10 * 1024 ** 3,
      },
      0,
      null,
    );
    storageSafety.markSuccess(new Date(RECEIVED_AT), { age: 0, budget: 0 });
  }
  const app = createPublicApp({
    database,
    operations: { storageSafety, metrics },
    shadowForwarder,
    buildOutbox({ transition }): OutboxDraft {
      return {
        mode: "disabled",
        deliveryId: `suppressed-${String(transition.issueId)}-${String(
          transition.generation,
        )}`,
        targetUrl: null,
        secretRef: null,
        signature: null,
        body: Buffer.from('{"action":"triggered"}'),
      };
    },
    now: options.now ?? (() => new Date(RECEIVED_AT)),
    onOperationalMetric(metric) {
      operationalMetrics.push(metric);
    },
    ...(options.limits === undefined ? {} : { limits: options.limits }),
  });
  openApplications.push(app);

  return {
    app,
    database,
    events: new EventRepository(database),
    issues: new IssueRepository(database),
    forwarded,
    operationalMetrics,
    metrics,
  };
}

async function postEnvelopeWithKey(
  app: FastifyInstance,
  publicKey: string,
  payload: Buffer,
  headers: Readonly<Record<string, string>> = {},
) {
  return app.inject({
    method: "POST",
    url: `/api/1/envelope/?sentry_version=7&sentry_key=${publicKey}&sentry_client=fixture`,
    headers,
    payload,
  });
}

async function postEnvelope(
  app: FastifyInstance,
  payload: Buffer,
  headers: Readonly<Record<string, string>> = {},
) {
  return app.inject({
    method: "POST",
    url: `/api/1/envelope/?sentry_version=7&sentry_key=${PUBLIC_KEY}&sentry_client=fixture`,
    headers,
    payload,
  });
}

function eventEnvelope(event: Readonly<Record<string, unknown>>): Buffer {
  const id =
    typeof event.event_id === "string" ? event.event_id : FIXTURE_EVENT_ID;
  return envelopeWithItems(id, [{ type: "event", payload: event }]);
}

function envelopeWithItems(
  envelopeEventId: string,
  items: readonly {
    readonly type: string;
    readonly payload: Readonly<Record<string, unknown>>;
  }[],
): Buffer {
  const chunks: Buffer[] = [
    Buffer.from(`${JSON.stringify({ event_id: envelopeEventId })}\n`),
  ];
  for (const item of items) {
    const payload = Buffer.from(JSON.stringify(item.payload));
    chunks.push(
      Buffer.from(
        `${JSON.stringify({ type: item.type, length: payload.byteLength })}\n`,
      ),
      payload,
      Buffer.from("\n"),
    );
  }
  return Buffer.concat(chunks);
}

function binaryEnvelope(id: string, environment: string): Buffer {
  const event = Buffer.from(
    JSON.stringify({ event_id: id, environment, level: "error" }),
  );
  const binary = Buffer.from([0, 1, 2, 3]);
  return Buffer.concat([
    Buffer.from(`${JSON.stringify({ event_id: id })}\n`),
    Buffer.from(`${JSON.stringify({ type: "event", length: event.length })}\n`),
    event,
    Buffer.from("\n"),
    Buffer.from(
      `${JSON.stringify({ type: "attachment", length: binary.length })}\n`,
    ),
    binary,
  ]);
}

function eventId(number: number): string {
  return number.toString(16).padStart(32, "0");
}

function count(database: ErrorHubDatabase, table: string): number {
  const row = database
    .prepare(`SELECT COUNT(*) AS count FROM ${table}`)
    .get() as { count: number };
  return row.count;
}

function projectSlug(database: ErrorHubDatabase, projectId: number): string {
  const row = database
    .prepare("SELECT slug FROM projects WHERE id = ?")
    .get(projectId) as { slug: string } | undefined;
  return row?.slug ?? "";
}

function expectSentryError(
  response: Awaited<ReturnType<FastifyInstance["inject"]>>,
  statusCode: number,
): void {
  expect(response.statusCode).toBe(statusCode);
  expect(response.headers["x-sentry-error"]).toBeTypeOf("string");
  expect(response.headers["x-sentry-error"]).not.toHaveLength(0);
  expect(response.headers["content-type"]).toContain("application/json");
}

import { gunzipSync } from "node:zlib";
import type { NormalizedEvent } from "@sentrybox/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPrivateApp } from "../private-app.js";
import { createOperationsContext } from "../operations.js";
import { openDatabase, type ErrorHubDatabase } from "../storage/database.js";
import { IssueRepository } from "../storage/issue-repository.js";
import { migrateDatabase } from "../storage/migrate.js";
import { ProjectRepository } from "../storage/project-repository.js";
import {
  decodeCursor,
  encodeCursor,
  encodeNullableFacetQueryValue,
  parseFilters,
} from "./query.js";

const PRIVATE_HOST = "hub.test:8443";
const PRIVATE_ORIGIN = `https://${PRIVATE_HOST}`;
const PUBLIC_HOST = "errors.test";
const NOW = "2026-07-28T12:00:00.000Z";
const NULL_FACET_QUERY = "~v1:n";
const EMPTY_FACET_QUERY = "~v1:s:";
const LITERAL_UNKNOWN_QUERY = "~v1:s:X191bmtub3duX18";
const LITERAL_TAG_QUERY = "~v1:s:fnYxOm4";

describe("private operator API", () => {
  let database: ErrorHubDatabase;
  let app: ReturnType<typeof createPrivateApp>;
  let firstIssueId: number;
  let secondIssueId: number;
  let deadLetterId: number;
  let firstEventRowId: number;
  let exportBatches: number[];
  let clock: Date;
  let secretFailure: Error | null;

  beforeEach(() => {
    database = openDatabase(":memory:");
    migrateDatabase(database, "2026-07-28T00:00:00.000Z");
    const seeded = seedDatabase(database);
    firstIssueId = seeded.firstIssueId;
    secondIssueId = seeded.secondIssueId;
    deadLetterId = seeded.deadLetterId;
    firstEventRowId = seeded.firstEventRowId;
    exportBatches = [];
    clock = new Date(NOW);
    secretFailure = null;
    const operations = createOperationsContext();
    operations.storageSafety.observeUsage(
      {
        databaseBytes: 100,
        walBytes: 20,
        shmBytes: 10,
        temporaryBytes: 5,
        dataDirectoryOtherBytes: 0,
        totalBytes: 135,
        freeBytes: 10 * 1024 ** 3,
      },
      0,
      "2026-07-28T08:00:01.000Z",
    );
    operations.storageSafety.markSuccess(new Date(NOW), { age: 0, budget: 0 });
    app = createPrivateApp({
      database,
      privateOrigin: new URL(PRIVATE_ORIGIN),
      organizationSlug: "intexuraos",
      allowedHosts: [PRIVATE_HOST],
      allowedOrigins: [PRIVATE_ORIGIN],
      publicIngestHosts: [PUBLIC_HOST],
      grafanaExploreUrl: new URL("https://grafana.test/explore"),
      operations,
      now: () => clock,
      createDeliveryId: () => "55555555-5555-4555-8555-555555555555",
      secrets: {
        references: () => ["HOOK_SECRET"],
        resolve: (reference) => {
          if (secretFailure !== null) throw secretFailure;
          if (reference !== "HOOK_SECRET") throw new Error("unknown secret");
          return "current-secret";
        },
      },
      exportBatchSize: 2,
      onExportBatch: (size) => exportBatches.push(size),
    });
  });

  afterEach(async () => {
    await app.close();
    database.close();
  });

  it("requires an allowed private Host on every request without treating bearer syntax as authentication", async () => {
    const missing = await app.inject({ method: "GET", url: "/health/live" });
    expect(missing.statusCode).toBe(403);

    const publicHost = await app.inject({
      method: "GET",
      url: "/api/issues",
      headers: { host: PUBLIC_HOST },
    });
    expect(publicHost.statusCode).toBe(403);

    const allowed = await app.inject({
      method: "GET",
      url: "/api/issues",
      headers: {
        host: PRIVATE_HOST,
        authorization: "Bearer syntactic-token",
      },
    });
    expect(allowed.statusCode).toBe(200);

    const disallowedGetOrigin = await app.inject({
      method: "GET",
      url: "/api/issues",
      headers: { host: PRIVATE_HOST, origin: "https://attacker.test" },
    });
    expect(disallowedGetOrigin.statusCode).toBe(403);

    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/issues",
          headers: { host: "HUB.TEST:8443" },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/issues",
          headers: { host: PRIVATE_HOST, origin: `${PRIVATE_ORIGIN}/` },
        })
      ).statusCode,
    ).toBe(403);
  });

  it("requires the approved Origin and JSON content type for mutations", async () => {
    const url = `/api/issues/${String(firstIssueId)}/resolve`;
    const missingOrigin = await app.inject({
      method: "POST",
      url,
      headers: { host: PRIVATE_HOST, "content-type": "application/json" },
      payload: {},
    });
    expect(missingOrigin.statusCode).toBe(403);

    const wrongOrigin = await app.inject({
      method: "POST",
      url,
      headers: {
        host: PRIVATE_HOST,
        origin: "https://attacker.test",
        "content-type": "application/json",
      },
      payload: {},
    });
    expect(wrongOrigin.statusCode).toBe(403);

    const wrongContentType = await app.inject({
      method: "POST",
      url,
      headers: { host: PRIVATE_HOST, origin: PRIVATE_ORIGIN },
      payload: "not-json",
    });
    expect(wrongContentType.statusCode).toBe(415);
  });

  it("lists issues with stable cursors, matching counts, exact timestamps, and facet OR/AND filters", async () => {
    const firstPage = await privateGet("/api/issues?limit=1");
    expect(firstPage.statusCode).toBe(200);
    const firstBody = firstPage.json<{
      items: Array<Record<string, unknown>>;
      nextCursor: string | null;
      facets: Record<string, unknown>;
    }>();
    expect(firstBody.items).toEqual([
      expect.objectContaining({
        id: firstIssueId,
        count: 3,
        matchingCount: 3,
        firstSeen: "2026-07-28T09:00:00.000Z",
        lastSeen: "2026-07-28T11:00:00.000Z",
        project: {
          id: "1",
          slug: "intexuraos-backend",
          name: "IntexuraOS Backend",
        },
      }),
    ]);
    expect(firstBody.nextCursor).toBeTypeOf("string");
    expect(firstBody.facets).toBeTypeOf("object");

    const filtered = await privateGet(
      `/api/issues?release=${encodeURIComponent(NULL_FACET_QUERY)}&release=1.0.0&environment=prod`,
    );
    expect(
      filtered.json<{ items: Array<{ id: number; matchingCount: number }> }>()
        .items,
    ).toEqual([
      expect.objectContaining({ id: firstIssueId, matchingCount: 2 }),
    ]);

    const nextPage = await privateGet(
      `/api/issues?limit=1&cursor=${encodeURIComponent(firstBody.nextCursor ?? "")}`,
    );
    expect(nextPage.json<{ items: Array<{ id: number }> }>().items).toEqual([
      expect.objectContaining({ id: secondIssueId }),
    ]);

    const repeatedCursor = await privateGet(
      `/api/issues?limit=1&cursor=${encodeURIComponent(firstBody.nextCursor ?? "")}`,
    );
    expect(repeatedCursor.json()).toEqual(nextPage.json());

    expect(parseFilters({ status: ["unresolved", "resolved"] }).status).toEqual(
      [],
    );
    const allStatuses = await privateGet(
      "/api/issues?status=unresolved&status=resolved",
    );
    expect(allStatuses.json<{ items: Array<{ id: number }> }>().items).toEqual(
      (await privateGet("/api/issues")).json<{ items: Array<{ id: number }> }>()
        .items,
    );
  });

  it("returns issue detail, issue facets, occurrence pages, and one normalized event with exact timestamps", async () => {
    const detail = await privateGet(`/api/issues/${String(firstIssueId)}`);
    expect(detail.statusCode).toBe(200);
    const detailBody = detail.json();
    expect(detailBody).toEqual(
      expect.objectContaining({
        id: firstIssueId,
        count: 3,
        firstSeen: "2026-07-28T09:00:00.000Z",
        lastSeen: "2026-07-28T11:00:00.000Z",
        facets: expect.objectContaining({
          release: expect.arrayContaining([
            expect.objectContaining({
              value: null,
              label: "Unknown version",
              queryValue: NULL_FACET_QUERY,
              count: 1,
            }),
          ]),
        }),
        deliveries: expect.any(Array),
      }),
    );
    const serializedDetail = JSON.stringify(detailBody);
    expect(serializedDetail).not.toContain("https://code-agent.test");
    expect(serializedDetail).not.toContain("HOOK_SECRET");
    expect(serializedDetail).not.toContain("0".repeat(64));
    expect(serializedDetail).not.toContain('{"action":"triggered"}');

    const events = await privateGet(
      `/api/issues/${String(firstIssueId)}/events?limit=2`,
    );
    const eventsBody = events.json<{
      items: Array<{ id: string; occurredAt: string; release: string | null }>;
      nextCursor: string | null;
    }>();
    expect(eventsBody.items.map((event) => event.id)).toEqual([
      eventId(3),
      eventId(2),
    ]);
    expect(eventsBody.items[0]).toEqual(
      expect.objectContaining({
        occurredAt: "2026-07-28T11:00:00.000Z",
        release: "1.0.0",
      }),
    );
    expect(eventsBody.nextCursor).toBeTypeOf("string");

    const event = await privateGet(`/api/events/${String(firstEventRowId)}`);
    expect(event.statusCode).toBe(200);
    expect(event.json()).toEqual(
      expect.objectContaining({
        id: firstEventRowId,
        eventId: eventId(1),
        issueId: firstIssueId,
        occurredAt: "2026-07-28T09:00:00.000Z",
        receivedAt: "2026-07-28T09:00:01.000Z",
        release: null,
        logLocator: expect.objectContaining({
          confidence: "exact_identifier",
          from: "2026-07-28T08:58:00.000Z",
          to: "2026-07-28T09:02:00.000Z",
          grafanaUrl: expect.stringContaining("https://grafana.test/explore"),
        }),
        normalized: expect.objectContaining({ release: null }),
      }),
    );
  });

  it("applies cross-facet predicates to one event row and paginates timestamp ties without gaps", async () => {
    const issues = new IssueRepository(database);
    const mismatch = issues.recordOccurrence({
      ...occurrenceInput(
        normalizedEvent(7, "2026-07-28T08:00:00.000Z", "release-a", "prod"),
        "e",
      ),
      buildOutbox: disabledOutbox("77777777-7777-4777-8777-777777777777"),
    });
    issues.recordOccurrence({
      ...occurrenceInput(
        normalizedEvent(8, "2026-07-28T08:00:00.000Z", "release-b", "dev"),
        "e",
      ),
      buildOutbox: disabledOutbox("88888888-8888-4888-8888-888888888888"),
    });
    const falseCombination = await privateGet(
      "/api/issues?release=release-b&environment=prod",
    );
    expect(
      falseCombination
        .json<{ items: Array<{ id: number }> }>()
        .items.map((item) => item.id),
    ).not.toContain(mismatch.issueId);

    const tiePage = await privateGet("/api/issues?limit=2");
    const tieBody = tiePage.json<{
      items: Array<{ id: number }>;
      nextCursor: string;
    }>();
    expect(tieBody.items.map((item) => item.id)).toEqual([
      firstIssueId,
      mismatch.issueId,
    ]);
    const tieNext = await privateGet(
      `/api/issues?limit=2&cursor=${encodeURIComponent(tieBody.nextCursor)}`,
    );
    expect(tieNext.json<{ items: Array<{ id: number }> }>().items).toEqual([
      expect.objectContaining({ id: secondIssueId }),
    ]);

    const sameTimeEvent: NormalizedEvent = {
      ...normalizedEvent(15, "2026-07-28T11:00:00.000Z", "1.0.0", "prod"),
      id: "ffffffffffffffffffffffffffffffff",
    };
    issues.recordOccurrence({
      ...occurrenceInput(sameTimeEvent, "a"),
      buildOutbox: disabledOutbox("99999999-9999-4999-8999-999999999999"),
    });
    const eventTiePage = await privateGet(
      `/api/issues/${String(firstIssueId)}/events?limit=1`,
    );
    const eventTieBody = eventTiePage.json<{
      items: Array<{ id: string }>;
      nextCursor: string;
    }>();
    expect(eventTieBody.items[0]?.id).toBe("ffffffffffffffffffffffffffffffff");
    const eventTieNext = await privateGet(
      `/api/issues/${String(firstIssueId)}/events?limit=1&cursor=${encodeURIComponent(eventTieBody.nextCursor)}`,
    );
    expect(
      eventTieNext.json<{ items: Array<{ id: string }> }>().items[0]?.id,
    ).toBe(eventId(3));
  });

  it("keeps null, empty, and literal nullable facet values collision-free through facets, filters, counts, and exports", async () => {
    const maximumUnicodeValue = "ą".repeat(1_024);
    expect(
      parseFilters({
        release: encodeNullableFacetQueryValue(maximumUnicodeValue),
      }).release,
    ).toEqual([maximumUnicodeValue]);
    const issues = new IssueRepository(database);
    let nullableIssueId: number | null = null;
    for (const [sequence, release, service] of [
      [20, null, null],
      [21, "__unknown__", "__unknown__"],
      [22, "~v1:n", "~v1:n"],
      [23, "", ""],
    ] as const) {
      const occurrence = issues.recordOccurrence({
        ...occurrenceInput(
          {
            ...normalizedEvent(
              sequence,
              `2026-07-28T0${String(sequence - 20)}:00:00.000Z`,
              release,
              "prod",
            ),
            serverName: service,
          },
          "f",
        ),
        buildOutbox: disabledOutbox(
          `${String(sequence).padStart(8, "0")}-3333-4333-8333-333333333333`,
        ),
      });
      nullableIssueId ??= occurrence.issueId;
    }
    const response = await privateGet("/api/facets");
    expect(response.statusCode).toBe(200);
    const facets = response.json<{
      release: Array<{
        value: string | null;
        queryValue: string;
        label: string | null;
        count: number;
      }>;
      service: Array<{
        value: string | null;
        queryValue: string;
        label: string | null;
        count: number;
      }>;
      environment: Array<{ value: string; count: number }>;
    }>();
    expect(facets).toEqual(
      expect.objectContaining({
        release: expect.arrayContaining([
          {
            value: null,
            queryValue: NULL_FACET_QUERY,
            label: "Unknown version",
            count: 2,
          },
          {
            value: "__unknown__",
            queryValue: LITERAL_UNKNOWN_QUERY,
            label: "__unknown__",
            count: 1,
          },
          {
            value: "~v1:n",
            queryValue: LITERAL_TAG_QUERY,
            label: "~v1:n",
            count: 1,
          },
          {
            value: "",
            queryValue: EMPTY_FACET_QUERY,
            label: "",
            count: 1,
          },
        ]),
        service: expect.arrayContaining([
          expect.objectContaining({
            value: null,
            queryValue: NULL_FACET_QUERY,
            count: 1,
          }),
          expect.objectContaining({
            value: "__unknown__",
            queryValue: LITERAL_UNKNOWN_QUERY,
            count: 1,
          }),
          expect.objectContaining({
            value: "~v1:n",
            queryValue: LITERAL_TAG_QUERY,
            count: 1,
          }),
          expect.objectContaining({
            value: "",
            queryValue: EMPTY_FACET_QUERY,
            count: 1,
          }),
        ]),
        environment: expect.arrayContaining([
          expect.objectContaining({ value: "prod", count: 7 }),
        ]),
      }),
    );

    const issueFacets = (
      await privateGet(`/api/issues/${String(nullableIssueId)}`)
    ).json<{
      facets: {
        release: Array<{ value: string | null; queryValue: string }>;
        service: Array<{ value: string | null; queryValue: string }>;
      };
    }>().facets;
    for (const facet of [issueFacets.release, issueFacets.service]) {
      expect(facet).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            value: null,
            queryValue: NULL_FACET_QUERY,
          }),
          expect.objectContaining({ value: "", queryValue: EMPTY_FACET_QUERY }),
          expect.objectContaining({
            value: "__unknown__",
            queryValue: LITERAL_UNKNOWN_QUERY,
          }),
          expect.objectContaining({
            value: "~v1:n",
            queryValue: LITERAL_TAG_QUERY,
          }),
        ]),
      );
    }

    for (const [queryValue, expected] of [
      [NULL_FACET_QUERY, { release: null, serverName: null }],
      [EMPTY_FACET_QUERY, { release: "", serverName: "" }],
      [
        LITERAL_UNKNOWN_QUERY,
        { release: "__unknown__", serverName: "__unknown__" },
      ],
      [LITERAL_TAG_QUERY, { release: "~v1:n", serverName: "~v1:n" }],
    ] as const) {
      const query = `release=${encodeURIComponent(queryValue)}&service=${encodeURIComponent(queryValue)}`;
      const filtered = await privateGet(`/api/issues?${query}`);
      expect(
        filtered.json<{ items: Array<{ matchingCount: number }> }>().items,
      ).toEqual([expect.objectContaining({ matchingCount: 1 })]);
      const exported = await privateGet(`/api/export?${query}`);
      expect(parseNdjson(exported.rawPayload)).toEqual([
        expect.objectContaining(expected),
      ]);
    }

    expect(
      (await privateGet("/api/issues?release=~v1:malformed")).statusCode,
    ).toBe(400);
  });

  it("resolves, manually reopens, and permanently deletes atomically at the supplied exact timestamp", async () => {
    const before = database
      .prepare("SELECT generation FROM issues WHERE id = ?")
      .get(firstIssueId) as { generation: number };
    const outboxBefore = database
      .prepare(
        "SELECT COUNT(*) AS count FROM webhook_outbox WHERE issue_id = ?",
      )
      .get(firstIssueId) as { count: number };
    const resolved = await privateMutation(
      "POST",
      `/api/issues/${String(firstIssueId)}/resolve`,
    );
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json()).toEqual(
      expect.objectContaining({
        status: "resolved",
        resolvedAt: NOW,
        updatedAt: NOW,
      }),
    );

    const reopened = await privateMutation(
      "POST",
      `/api/issues/${String(firstIssueId)}/reopen`,
    );
    expect(reopened.statusCode).toBe(200);
    expect(reopened.json()).toEqual(
      expect.objectContaining({
        status: "unresolved",
        resolvedAt: null,
        updatedAt: NOW,
      }),
    );
    expect(
      database
        .prepare("SELECT generation FROM issues WHERE id = ?")
        .get(firstIssueId),
    ).toEqual(before);
    expect(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM webhook_outbox WHERE issue_id = ?",
        )
        .get(firstIssueId),
    ).toEqual(outboxBefore);

    const deleted = await privateMutation(
      "DELETE",
      `/api/issues/${String(firstIssueId)}`,
    );
    expect(deleted.statusCode).toBe(204);
    expect(
      database
        .prepare("SELECT COUNT(*) AS count FROM events WHERE issue_id = ?")
        .get(firstIssueId),
    ).toEqual({ count: 0 });
    expect(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM webhook_outbox WHERE issue_id = ?",
        )
        .get(firstIssueId),
    ).toEqual({ count: 0 });
  });

  it("streams one JSON event and gzip NDJSON issue and filtered exports from stored redacted payloads", async () => {
    const one = await privateGet(
      `/api/events/${String(firstEventRowId)}/download`,
    );
    expect(one.statusCode).toBe(200);
    expect(one.headers["content-type"]).toContain("application/json");
    expect(one.json()).toEqual(
      expect.objectContaining({ id: eventId(1), release: null }),
    );

    const issue = await privateGet(
      `/api/issues/${String(firstIssueId)}/download`,
    );
    expect(issue.headers["content-type"]).toContain("application/x-ndjson");
    expect(issue.headers["content-encoding"]).toBe("gzip");
    expect(issue.headers["content-length"]).toBeUndefined();
    expect(parseNdjson(issue.rawPayload)).toHaveLength(3);

    const filtered = await privateGet(
      `/api/export?release=${encodeURIComponent(NULL_FACET_QUERY)}&environment=prod`,
    );
    expect(filtered.headers["content-encoding"]).toBe("gzip");
    expect(filtered.headers["content-length"]).toBeUndefined();
    expect(parseNdjson(filtered.rawPayload)).toEqual([
      expect.objectContaining({ id: eventId(1), release: null }),
    ]);
    expect(exportBatches.length).toBeGreaterThan(2);
    expect(Math.max(...exportBatches)).toBe(2);
  });

  it("creates a separately audited one-attempt redrive for a dead letter", async () => {
    const response = await privateMutation(
      "POST",
      `/api/webhook-deliveries/${String(deadLetterId)}/retry`,
    );
    expect(response.statusCode).toBe(202);
    const redriveBody = response.json();
    expect(redriveBody).toEqual(
      expect.objectContaining({
        originalOutboxId: deadLetterId,
        deliveryId: "55555555-5555-4555-8555-555555555555",
        state: "pending",
        requestedAt: NOW,
      }),
    );
    const serializedRedrive = JSON.stringify(redriveBody);
    expect(serializedRedrive).not.toContain("https://code-agent.test");
    expect(serializedRedrive).not.toContain("HOOK_SECRET");
    expect(serializedRedrive).not.toContain("0".repeat(64));
    expect(
      database
        .prepare("SELECT state FROM webhook_outbox WHERE id = ?")
        .get(deadLetterId),
    ).toEqual({ state: "dead_letter" });
    expect(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM webhook_redrives WHERE original_outbox_id = ?",
        )
        .get(deadLetterId),
    ).toEqual({ count: 1 });
    await privateMutation("DELETE", `/api/issues/${String(firstIssueId)}`);
    expect(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM webhook_redrives WHERE original_outbox_id = ?",
        )
        .get(deadLetterId),
    ).toEqual({ count: 0 });
  });

  it("classifies retry validation, missing/conflict, and internal failures without leaking dependency data", async () => {
    const appWithoutSecrets = createPrivateApp({
      database,
      operations: createOperationsContext(),
      privateOrigin: new URL(PRIVATE_ORIGIN),
      organizationSlug: "intexuraos",
      allowedHosts: [PRIVATE_HOST],
      allowedOrigins: [PRIVATE_ORIGIN],
      publicIngestHosts: [PUBLIC_HOST],
    });
    const malformedWithoutSecrets = await appWithoutSecrets.inject({
      method: "POST",
      url: "/api/webhook-deliveries/not-an-id/retry",
      headers: {
        host: PRIVATE_HOST,
        origin: PRIVATE_ORIGIN,
        "content-type": "application/json",
      },
      payload: {},
    });
    expect(malformedWithoutSecrets.statusCode).toBe(400);
    expect(malformedWithoutSecrets.json()).toEqual({
      error: { code: "invalid_request", message: "delivery id is invalid" },
    });
    const validWithoutSecrets = await appWithoutSecrets.inject({
      method: "POST",
      url: `/api/webhook-deliveries/${String(deadLetterId)}/retry`,
      headers: {
        host: PRIVATE_HOST,
        origin: PRIVATE_ORIGIN,
        "content-type": "application/json",
      },
      payload: {},
    });
    await appWithoutSecrets.close();
    expect(validWithoutSecrets.statusCode).toBe(409);

    const malformed = await privateMutation(
      "POST",
      "/api/webhook-deliveries/not-an-id/retry",
    );
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toEqual({
      error: { code: "invalid_request", message: "delivery id is invalid" },
    });

    const missing = await privateMutation(
      "POST",
      "/api/webhook-deliveries/999999/retry",
    );
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({
      error: { code: "not_found", message: "Delivery not found" },
    });

    const nonDead = database
      .prepare(
        "SELECT id FROM webhook_outbox WHERE state <> 'dead_letter' LIMIT 1",
      )
      .get() as { id: number };
    const conflictResponse = await privateMutation(
      "POST",
      `/api/webhook-deliveries/${String(nonDead.id)}/retry`,
    );
    expect(conflictResponse.statusCode).toBe(409);
    expect(conflictResponse.json()).toEqual({
      error: { code: "conflict", message: "Delivery cannot be retried" },
    });

    database
      .prepare(
        `UPDATE project_ingest_keys
         SET webhook_mode = 'disabled', webhook_target_url = NULL,
             webhook_secret_ref = NULL, enabled_at = NULL
         WHERE project_id = 1 AND environment = 'prod'`,
      )
      .run();
    const disabledDestination = await privateMutation(
      "POST",
      `/api/webhook-deliveries/${String(deadLetterId)}/retry`,
    );
    expect(disabledDestination.statusCode).toBe(409);
    expect(disabledDestination.json()).toEqual({
      error: { code: "conflict", message: "Delivery cannot be retried" },
    });
    database
      .prepare(
        `UPDATE project_ingest_keys
         SET webhook_mode = 'live',
             webhook_target_url = 'https://code-agent.test/api/code/webhooks/sentry',
             webhook_secret_ref = 'HOOK_SECRET', enabled_at = ?
         WHERE project_id = 1 AND environment = 'prod'`,
      )
      .run(NOW);

    secretFailure = new Error(
      "TOP_SECRET https://private-target.test HOOK_SECRET",
    );
    const dependencyFailure = await privateMutation(
      "POST",
      `/api/webhook-deliveries/${String(deadLetterId)}/retry`,
    );
    expect(dependencyFailure.statusCode).toBe(500);
    expect(dependencyFailure.json()).toEqual({
      error: { code: "internal_error", message: "Internal server error" },
    });
    expect(dependencyFailure.body).not.toMatch(
      /TOP_SECRET|private-target|HOOK_SECRET/u,
    );

    secretFailure = null;
    clock = new Date(Number.NaN);
    const clockFailure = await privateMutation(
      "POST",
      `/api/webhook-deliveries/${String(deadLetterId)}/retry`,
    );
    expect(clockFailure.statusCode).toBe(500);
    expect(clockFailure.body).not.toContain("private API clock");
  });

  it("uses the database row locator when two projects contain the same SDK event id", async () => {
    const projects = new ProjectRepository(database);
    projects.create({
      id: 2,
      slug: "intexuraos-web",
      name: "IntexuraOS Web",
      enabled: true,
      createdAt: "2026-07-28T00:00:00.000Z",
    });
    projects.setIngestKey({
      projectId: 2,
      environment: "prod",
      publicKey: "web-prod-key",
      allowedOrigins: [],
      forwardingMode: "disabled",
      forwardingSecretRef: null,
      webhookMode: "disabled",
      webhookTargetUrl: null,
      webhookSecretRef: null,
      enabledAt: null,
    });
    const duplicate = new IssueRepository(database).recordOccurrence({
      ...occurrenceInput(
        normalizedEvent(1, "2026-07-28T11:30:00.000Z", "web-1", "prod"),
        "c",
      ),
      projectId: 2,
      buildOutbox: () => ({
        deliveryId: "33333333-3333-4333-8333-333333333333",
        mode: "disabled" as const,
        targetUrl: null,
        secretRef: null,
        signature: null,
        body: Buffer.from('{"action":"triggered"}', "utf8"),
      }),
    });

    expect(
      (await privateGet(`/api/events/${String(firstEventRowId)}`)).json(),
    ).toEqual(
      expect.objectContaining({
        id: firstEventRowId,
        eventId: eventId(1),
        projectId: 1,
      }),
    );
    expect(
      (await privateGet(`/api/events/${String(duplicate.eventRowId)}`)).json(),
    ).toEqual(
      expect.objectContaining({
        id: duplicate.eventRowId,
        eventId: eventId(1),
        projectId: 2,
      }),
    );
  });

  it("exposes operational status, fixed-cardinality metrics, liveness, and readiness", async () => {
    const status = await privateGet("/api/system/status");
    expect(status.statusCode).toBe(200);
    const statusBody = status.json();
    expect(statusBody).toEqual(
      expect.objectContaining({
        status: "ok",
        database: { ready: true, migrationCurrent: true },
        retention: expect.objectContaining({
          knownSuccessful: true,
          lastRun: NOW,
        }),
        ingest: { accepting: true },
        outbox: expect.objectContaining({ deadLetter: 1 }),
      }),
    );
    expect(JSON.stringify(statusBody)).not.toMatch(
      /HOOK_SECRET|code-agent\.test|[0-9a-f]{64}/u,
    );

    const metrics = await privateGet("/metrics");
    expect(metrics.statusCode).toBe(200);
    expect(metrics.headers["content-type"]).toContain("text/plain");
    expect(metrics.body).toContain("sentrybox_storage_physical_bytes 135");
    expect(metrics.body).toContain(
      'sentrybox_outbox_deliveries{state="dead_letter"} 1',
    );

    expect((await privateGet("/health/live")).json()).toEqual({ status: "ok" });
    expect((await privateGet("/health/ready")).json()).toEqual({
      status: "ready",
    });
  });

  it("returns structured validation and not-found responses", async () => {
    expect((await privateGet("/api/issues?limit=0")).statusCode).toBe(400);
    expect((await privateGet("/api/issues?cursor=broken")).statusCode).toBe(
      400,
    );
    expect(
      (await privateGet(`/api/issues?cursor=${"a".repeat(2_049)}`)).statusCode,
    ).toBe(400);
    expect(
      (await privateGet(`/api/issues?query=${"q".repeat(1_025)}`)).statusCode,
    ).toBe(400);
    expect((await privateGet("/api/issues/999999")).statusCode).toBe(404);
    expect((await privateGet("/api/events/999999")).statusCode).toBe(404);
    for (const value of [
      "2026",
      "2026-07-28",
      "07/28/2026",
      "2026-07-28T11:00:00+00:00",
      "2026-07-28T11:00:00Z",
    ]) {
      expect(
        (
          await privateGet(
            `/api/issues?from=${encodeURIComponent(value)}&to=2026-07-28T12%3A00%3A00.000Z`,
          )
        ).statusCode,
      ).toBe(400);
      const cursor = rawCursor(value, firstIssueId);
      expect(
        (await privateGet(`/api/issues?cursor=${encodeURIComponent(cursor)}`))
          .statusCode,
      ).toBe(400);
    }

    const canonicalTimestamp = "2026-07-28T11:00:00.000Z";
    const canonicalCursor = encodeCursor(canonicalTimestamp, firstIssueId);
    expect(decodeCursor(canonicalCursor, "number")).toEqual({
      timestamp: canonicalTimestamp,
      id: firstIssueId,
    });
    expect(encodeCursor(canonicalTimestamp, firstIssueId)).toBe(
      canonicalCursor,
    );
    for (const json of [
      `{"t":"${canonicalTimestamp}","v":1,"i":${String(firstIssueId)}}`,
      `{ "v":1,"t":"${canonicalTimestamp}","i":${String(firstIssueId)} }`,
      `{"v":1,"t":"${canonicalTimestamp}","i":1e0}`,
      `{"v":1,"t":"${canonicalTimestamp}","i":0,"i":${String(firstIssueId)}}`,
      `{"v":1,"t":"2026-07-28T11:00:00.000\\u005a","i":${String(firstIssueId)}}`,
      `{"v":1,"t":"${canonicalTimestamp}","i":${String(firstIssueId)},"extra":{}}`,
    ]) {
      const nonCanonicalCursor = Buffer.from(json, "utf8").toString(
        "base64url",
      );
      expect(
        (
          await privateGet(
            `/api/issues?cursor=${encodeURIComponent(nonCanonicalCursor)}`,
          )
        ).statusCode,
      ).toBe(400);
    }
    const nonCanonicalEventCursor = Buffer.from(
      `{"t":"${canonicalTimestamp}","v":1,"i":"${eventId(1)}"}`,
      "utf8",
    ).toString("base64url");
    expect(
      (
        await privateGet(
          `/api/issues/${String(firstIssueId)}/events?cursor=${encodeURIComponent(nonCanonicalEventCursor)}`,
        )
      ).statusCode,
    ).toBe(400);
  });

  async function privateGet(url: string) {
    return app.inject({ method: "GET", url, headers: { host: PRIVATE_HOST } });
  }

  async function privateMutation(method: "POST" | "DELETE", url: string) {
    return app.inject({
      method,
      url,
      headers: {
        host: PRIVATE_HOST,
        origin: PRIVATE_ORIGIN,
        "content-type": "application/json",
      },
      payload: {},
    });
  }
});

function seedDatabase(database: ErrorHubDatabase): {
  firstIssueId: number;
  secondIssueId: number;
  deadLetterId: number;
  firstEventRowId: number;
} {
  const projects = new ProjectRepository(database);
  projects.create({
    id: 1,
    slug: "intexuraos-backend",
    name: "IntexuraOS Backend",
    enabled: true,
    createdAt: "2026-07-28T00:00:00.000Z",
  });
  for (const environment of ["prod", "dev"]) {
    projects.setIngestKey({
      projectId: 1,
      environment,
      publicKey: `${environment}-key`,
      allowedOrigins: [],
      forwardingMode: "disabled",
      forwardingSecretRef: null,
      webhookMode: "live",
      webhookTargetUrl: "https://code-agent.test/api/code/webhooks/sentry",
      webhookSecretRef: "HOOK_SECRET",
      enabledAt: "2026-07-28T00:00:00.000Z",
      webhookSecrets: { references: () => ["HOOK_SECRET"] },
    });
  }

  const issues = new IssueRepository(database);
  const first = issues.recordOccurrence(
    occurrenceInput(
      normalizedEvent(1, "2026-07-28T09:00:00.000Z", null, "prod"),
      "a",
    ),
  );
  issues.recordOccurrence(
    occurrenceInput(
      normalizedEvent(2, "2026-07-28T10:00:00.000Z", "1.0.0", "dev"),
      "a",
    ),
  );
  issues.recordOccurrence(
    occurrenceInput(
      normalizedEvent(3, "2026-07-28T11:00:00.000Z", "1.0.0", "prod"),
      "a",
    ),
  );
  const second = issues.recordOccurrence(
    occurrenceInput(
      normalizedEvent(
        4,
        "2026-07-28T08:00:00.000Z",
        "2.0.0",
        "prod",
        "Queue warning",
        "warn",
      ),
      "b",
    ),
  );
  database
    .prepare(
      `UPDATE webhook_outbox
       SET state = 'dead_letter', next_attempt = NULL, last_error = 'HTTP 400'
       WHERE id = ?`,
    )
    .run(first.outboxId);
  return {
    firstIssueId: first.issueId,
    secondIssueId: second.issueId,
    deadLetterId: first.outboxId ?? 0,
    firstEventRowId: first.eventRowId,
  };
}

function occurrenceInput(event: NormalizedEvent, digestCharacter: string) {
  return {
    projectId: 1,
    event,
    fingerprint: {
      version: 1 as const,
      digest: digestCharacter.repeat(64),
      explanation: ["test fingerprint"],
    },
    buildOutbox: () => ({
      deliveryId: `${digestCharacter === "a" ? "11111111-1111-4111-8111-111111111111" : "22222222-2222-4222-8222-222222222222"}`,
      mode: "live" as const,
      targetUrl: "https://code-agent.test/api/code/webhooks/sentry",
      secretRef: "HOOK_SECRET",
      signature: "0".repeat(64),
      body: Buffer.from('{"action":"triggered"}', "utf8"),
    }),
  };
}

function disabledOutbox(deliveryId: string) {
  return () => ({
    deliveryId,
    mode: "disabled" as const,
    targetUrl: null,
    secretRef: null,
    signature: null,
    body: Buffer.from('{"action":"triggered"}', "utf8"),
  });
}

function normalizedEvent(
  sequence: number,
  occurredAt: string,
  release: string | null,
  environment: string,
  title = "TypeError: test failure",
  level: NormalizedEvent["level"] = "error",
): NormalizedEvent {
  const id = eventId(sequence);
  return {
    id,
    occurredAt,
    receivedAt: new Date(Date.parse(occurredAt) + 1_000).toISOString(),
    level,
    title,
    message: `message ${String(sequence)}`,
    exception: {
      type: "TypeError",
      value: "test failure",
      mechanism: { type: "generic", handled: false },
      frames: [
        {
          filename: "src/test.ts",
          function: "run",
          module: "test",
          lineno: 12,
          colno: 4,
          in_app: true,
        },
      ],
      discardedValues: 0,
    },
    breadcrumbs: [
      {
        timestamp: occurredAt,
        type: "default",
        category: "test",
        level: "info",
        message: "before failure",
      },
    ],
    tags: { component: "api" },
    release,
    environment,
    serverName: "code-agent",
    platform: "node",
    logger: "test",
    requestId: `req-${String(sequence)}`,
    traceId: `trace-${String(sequence)}`,
    taskId: `task-${String(sequence)}`,
    payload: {
      contexts: { runtime: { name: "node", version: "22.23.1" } },
      extras: { operation: "test" },
      correlations: {},
    },
    payloadBytes: 100,
    truncated: false,
    truncationReasons: [],
  };
}

function eventId(sequence: number): string {
  return sequence.toString(16).padStart(32, "0");
}

function parseNdjson(payload: Buffer): unknown[] {
  return gunzipSync(payload)
    .toString("utf8")
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as unknown);
}

function rawCursor(timestamp: string, id: number): string {
  return Buffer.from(
    JSON.stringify({ v: 1, t: timestamp, i: id }),
    "utf8",
  ).toString("base64url");
}

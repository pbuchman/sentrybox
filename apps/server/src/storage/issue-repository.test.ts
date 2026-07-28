import { gunzipSync } from "node:zlib";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FingerprintResult } from "@intexura-error-hub/domain";
import type { NormalizedEvent } from "@intexura-error-hub/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDatabase, type ErrorHubDatabase } from "./database.js";
import {
  decodeNormalizedPayload,
  encodeNormalizedPayload,
  EventRepository,
} from "./event-repository.js";
import { IssueRepository } from "./issue-repository.js";
import { migrateDatabase } from "./migrate.js";
import { OutboxRepository } from "./outbox-repository.js";
import { ProjectRepository } from "./project-repository.js";

const FINGERPRINT: FingerprintResult = {
  version: 1,
  digest: "a".repeat(64),
  explanation: ["exception:TypeError", "service:api"],
};

let directory: string;
let database: ErrorHubDatabase;
let issues: IssueRepository;
let events: EventRepository;
let outbox: OutboxRepository;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "error-hub-issues-"));
  database = openDatabase(join(directory, "error-hub.sqlite"));
  migrateDatabase(database, "2026-07-28T10:00:00.000Z");
  const projects = new ProjectRepository(database);
  projects.create({
    id: 1,
    slug: "intexuraos-backend",
    name: "IntexuraOS Backend",
    enabled: true,
    createdAt: "2026-07-28T10:00:00.000Z",
  });
  projects.setIngestKey({
    projectId: 1,
    environment: "dev",
    publicKey: "issue-tests",
    allowedOrigins: [],
    forwardingMode: "disabled",
    forwardingSecretRef: null,
    webhookMode: "live",
    webhookTargetUrl: "https://code-agent.example/api/code/webhooks/sentry",
    webhookSecretRef: "CODE_AGENT_HMAC_BACKEND_DEV",
    enabledAt: "2026-07-28T10:00:00.000Z",
    webhookSecrets: { references: () => ["CODE_AGENT_HMAC_BACKEND_DEV"] },
  });
  issues = new IssueRepository(database);
  events = new EventRepository(database);
  outbox = new OutboxRepository(database);
});

afterEach(() => {
  database.close();
  rmSync(directory, { force: true, recursive: true });
});

describe("IssueRepository.recordOccurrence", () => {
  it("treats an SDK retry as idempotent without changing counts or outbox", () => {
    const buildOutbox = vi.fn(liveOutbox);
    const first = issues.recordOccurrence({
      projectId: 1,
      event: normalizedEvent("event-1"),
      fingerprint: FINGERPRINT,
      buildOutbox,
    });
    const retry = issues.recordOccurrence({
      projectId: 1,
      event: normalizedEvent("event-1", {
        title: "retry must not replace title",
      }),
      fingerprint: FINGERPRINT,
      buildOutbox,
    });

    expect(first).toMatchObject({
      duplicate: false,
      outcome: "created",
      generation: 1,
    });
    expect(retry).toEqual({
      duplicate: true,
      issueId: first.issueId,
      eventRowId: first.eventRowId,
      generation: 1,
      outcome: "repeated",
      outboxId: first.outboxId,
    });
    expect(buildOutbox).toHaveBeenCalledTimes(1);
    expect(issues.getById(first.issueId)).toMatchObject({
      title: "TypeError: boom",
      occurrenceCount: 1,
      generation: 1,
      status: "unresolved",
    });
    expect(events.countByIssue(first.issueId)).toBe(1);
    expect(outbox.listByIssue(first.issueId)).toHaveLength(1);
  });

  it("counts different event IDs once and updates retained facet counts", () => {
    const first = issues.recordOccurrence({
      projectId: 1,
      event: normalizedEvent("event-1"),
      fingerprint: FINGERPRINT,
      buildOutbox: liveOutbox,
    });
    const second = issues.recordOccurrence({
      projectId: 1,
      event: normalizedEvent("event-2", {
        occurredAt: "2026-07-28T10:05:00.000Z",
        receivedAt: "2026-07-28T10:05:01.000Z",
        release: "2.0.0",
        level: "fatal",
      }),
      fingerprint: FINGERPRINT,
      buildOutbox: liveOutbox,
    });

    expect(second).toMatchObject({
      duplicate: false,
      outcome: "repeated",
      issueId: first.issueId,
      generation: 1,
      outboxId: null,
    });
    expect(issues.getById(first.issueId)).toMatchObject({
      occurrenceCount: 2,
      firstSeen: "2026-07-28T10:00:00.000Z",
      lastSeen: "2026-07-28T10:05:00.000Z",
      highestLevel: "fatal",
    });
    expect(issues.listFacets(first.issueId)).toEqual([
      {
        facetType: "environment",
        facetValue: "dev",
        count: 2,
        lastSeen: "2026-07-28T10:05:00.000Z",
      },
      {
        facetType: "level",
        facetValue: "error",
        count: 1,
        lastSeen: "2026-07-28T10:00:00.000Z",
      },
      {
        facetType: "level",
        facetValue: "fatal",
        count: 1,
        lastSeen: "2026-07-28T10:05:00.000Z",
      },
      {
        facetType: "release",
        facetValue: "1.0.0",
        count: 1,
        lastSeen: "2026-07-28T10:00:00.000Z",
      },
      {
        facetType: "release",
        facetValue: "2.0.0",
        count: 1,
        lastSeen: "2026-07-28T10:05:00.000Z",
      },
      {
        facetType: "service",
        facetValue: "api",
        count: 2,
        lastSeen: "2026-07-28T10:05:00.000Z",
      },
    ]);
    expect(outbox.listByIssue(first.issueId)).toHaveLength(1);
  });

  it("reopens a resolved issue and increments its generation exactly once", () => {
    const first = issues.recordOccurrence({
      projectId: 1,
      event: normalizedEvent("event-1"),
      fingerprint: FINGERPRINT,
      buildOutbox: liveOutbox,
    });
    expect(
      issues.resolve(first.issueId, "2026-07-28T10:03:00.000Z"),
    ).toMatchObject({ status: "resolved", generation: 1 });

    const regression = issues.recordOccurrence({
      projectId: 1,
      event: normalizedEvent("event-2", {
        occurredAt: "2026-07-28T10:05:00.000Z",
        receivedAt: "2026-07-28T10:05:01.000Z",
      }),
      fingerprint: FINGERPRINT,
      buildOutbox: liveOutbox,
    });
    const repeat = issues.recordOccurrence({
      projectId: 1,
      event: normalizedEvent("event-3", {
        occurredAt: "2026-07-28T10:06:00.000Z",
        receivedAt: "2026-07-28T10:06:01.000Z",
      }),
      fingerprint: FINGERPRINT,
      buildOutbox: liveOutbox,
    });

    expect(regression).toMatchObject({ outcome: "regressed", generation: 2 });
    expect(repeat).toMatchObject({ outcome: "repeated", generation: 2 });
    expect(issues.getById(first.issueId)).toMatchObject({
      status: "unresolved",
      generation: 2,
      resolvedAt: null,
      occurrenceCount: 3,
    });
    expect(outbox.listByIssue(first.issueId).map((row) => row.cause)).toEqual([
      "created",
      "regressed",
    ]);
  });

  it("persists deterministic compressed redacted normalized JSON after indexes", () => {
    const event = normalizedEvent("event-1");
    const encodedA = encodeNormalizedPayload(event);
    const encodedB = encodeNormalizedPayload({
      ...event,
      payload: {
        correlations: event.payload.correlations,
        extras: event.payload.extras,
        contexts: event.payload.contexts,
      },
    });
    expect(encodedA.json).toBe(encodedB.json);
    expect(encodedA.gzip).toEqual(encodedB.gzip);
    expect(gunzipSync(encodedA.gzip).toString("utf8")).toBe(encodedA.json);
    expect(decodeNormalizedPayload(encodedA.gzip)).toEqual(event);

    const result = issues.recordOccurrence({
      projectId: 1,
      event,
      fingerprint: FINGERPRINT,
      buildOutbox: liveOutbox,
    });
    const stored = events.getByRowId(result.eventRowId);
    expect(stored).toMatchObject({
      eventId: "event-1",
      projectId: 1,
      issueId: result.issueId,
      environment: "dev",
      release: "1.0.0",
      service: "api",
      level: "error",
      requestId: "request-1",
      traceId: "trace-1",
      taskId: "task-1",
      payloadBytes: Buffer.byteLength(encodedA.json),
      payload: event,
    });
  });

  it("rolls back issue, event, facets, and outbox together on an outbox error", () => {
    expect(() =>
      issues.recordOccurrence({
        projectId: 1,
        event: normalizedEvent("event-1"),
        fingerprint: FINGERPRINT,
        buildOutbox: () => {
          throw new Error("cannot build webhook");
        },
      }),
    ).toThrow("cannot build webhook");

    for (const table of [
      "issues",
      "events",
      "event_tags",
      "issue_facets",
      "webhook_outbox",
    ]) {
      expect(rowCount(database, table), table).toBe(0);
    }
  });

  it("cascades permanent issue deletion through events, tags, facets, and outbox", () => {
    const created = issues.recordOccurrence({
      projectId: 1,
      event: normalizedEvent("event-1"),
      fingerprint: FINGERPRINT,
      buildOutbox: liveOutbox,
    });
    expect(rowCount(database, "event_tags")).toBe(2);
    expect(issues.delete(created.issueId)).toBe(true);

    for (const table of [
      "issues",
      "events",
      "event_tags",
      "issue_facets",
      "webhook_outbox",
    ]) {
      expect(rowCount(database, table), table).toBe(0);
    }
    expect(rowCount(database, "projects")).toBe(1);
  });

  it("keeps persisted outbox content immutable while allowing delivery state changes", () => {
    const created = issues.recordOccurrence({
      projectId: 1,
      event: normalizedEvent("event-1"),
      fingerprint: FINGERPRINT,
      buildOutbox: liveOutbox,
    });
    if (created.outboxId === null) {
      throw new Error("expected outbox row");
    }

    expect(() =>
      database
        .prepare("UPDATE webhook_outbox SET body = ? WHERE id = ?")
        .run(Buffer.from("changed"), created.outboxId),
    ).toThrow(/immutable/i);
    expect(
      outbox.claimDue(
        "2026-07-28T10:00:01.000Z",
        "2026-07-28T10:00:11.000Z",
        "issue-test-lease",
        1,
      ),
    ).toHaveLength(1);
    expect(
      outbox.completeDelivered(
        created.outboxId,
        "issue-test-lease",
        "2026-07-28T10:01:00.000Z",
      ),
    ).toBe(true);
    expect(outbox.getById(created.outboxId)).toMatchObject({
      state: "delivered",
      attempts: 1,
      deliveredAt: "2026-07-28T10:01:00.000Z",
    });
  });

  it("records disabled webhook transitions as permanently suppressed", () => {
    const created = issues.recordOccurrence({
      projectId: 1,
      event: normalizedEvent("event-1"),
      fingerprint: FINGERPRINT,
      buildOutbox: ({ issueId, generation }) => ({
        deliveryId: `suppressed-${issueId}-${generation}`,
        mode: "disabled",
        targetUrl: null,
        secretRef: null,
        signature: null,
        body: Buffer.from('{"action":"triggered"}'),
      }),
    });
    if (created.outboxId === null) {
      throw new Error("expected outbox row");
    }
    const outboxId = created.outboxId;
    expect(outbox.getById(outboxId)).toMatchObject({
      destinationMode: "disabled",
      state: "suppressed",
      attempts: 0,
      nextAttempt: null,
      targetUrl: null,
      secretRef: null,
    });
    expect(
      outbox.claimDue(
        "2026-07-28T10:00:01.000Z",
        "2026-07-28T10:00:11.000Z",
        "suppressed-lease",
        1,
      ),
    ).toHaveLength(0);
  });
});

function normalizedEvent(
  id: string,
  overrides: Partial<NormalizedEvent> = {},
): NormalizedEvent {
  return {
    id,
    occurredAt: "2026-07-28T10:00:00.000Z",
    receivedAt: "2026-07-28T10:00:01.000Z",
    level: "error",
    title: "TypeError: boom",
    message: "boom",
    exception: {
      type: "TypeError",
      value: "boom",
      mechanism: {},
      frames: [{ filename: "src/app.ts", function: "run", in_app: true }],
      discardedValues: 0,
    },
    breadcrumbs: [{ category: "request", message: "redacted breadcrumb" }],
    tags: { component: "worker", region: "eu" },
    release: "1.0.0",
    environment: "dev",
    serverName: "api",
    platform: "node",
    logger: "api.worker",
    requestId: "request-1",
    traceId: "trace-1",
    taskId: "task-1",
    payload: {
      contexts: { runtime: { name: "node", version: "22" } },
      extras: { operation: "dispatch" },
      correlations: {
        requestId: { source: "tags", key: "requestId" },
      },
    },
    payloadBytes: 128,
    truncated: false,
    truncationReasons: [],
    ...overrides,
  };
}

function liveOutbox(input: {
  issueId: number;
  projectId: number;
  eventId: string;
  generation: number;
  cause: "created" | "regressed";
}) {
  return {
    deliveryId: `delivery-${input.issueId}-${input.generation}`,
    mode: "live" as const,
    targetUrl: "https://code-agent.example/api/code/webhooks/sentry",
    secretRef: "CODE_AGENT_HMAC_BACKEND_DEV",
    signature: "a".repeat(64),
    body: Buffer.from(
      JSON.stringify({ issueId: input.issueId, eventId: input.eventId }),
    ),
  };
}

function rowCount(database: ErrorHubDatabase, table: string): number {
  const row = database
    .prepare(`SELECT COUNT(*) AS count FROM ${table}`)
    .get() as {
    count: number;
  };
  return row.count;
}

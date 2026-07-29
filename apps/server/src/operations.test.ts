import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createPrivateApp } from "./private-app.js";
import { createPublicApp } from "./public-app.js";
import { createOperationsContext } from "./operations.js";
import { openDatabase, type ErrorHubDatabase } from "./storage/database.js";
import { migrateDatabase } from "./storage/migrate.js";
import { OutboxRepository } from "./storage/outbox-repository.js";
import { ProjectRepository } from "./storage/project-repository.js";
import { WebhookDispatcher } from "./webhooks/dispatcher.js";
import {
  DEFAULT_RETENTION_CONFIG,
  MAX_UNMEASURED_EVENT_PHYSICAL_BYTES,
} from "./retention/storage-budget.js";
import {
  type RetentionConfig,
  type PhysicalStorageUsage,
} from "./retention/storage-budget.js";
import { RetentionSweeper } from "./retention/sweeper.js";

const NOW = "2026-08-28T10:00:00.000Z";
const PUBLIC_KEY = "shared-operations-key";
const PRIVATE_HOST = "hub.test:8443";
const PRIVATE_ORIGIN = `https://${PRIVATE_HOST}`;
const apps: FastifyInstance[] = [];
const databases: ErrorHubDatabase[] = [];

afterEach(async () => {
  for (const app of apps.splice(0).reverse()) await app.close();
  for (const database of databases.splice(0).reverse()) database.close();
});

describe("shared operations composition", () => {
  it("drives public admission, private health/status, and all private metrics from one required context", async () => {
    const database = openDatabase(":memory:");
    databases.push(database);
    migrateDatabase(database, NOW);
    const projects = new ProjectRepository(database);
    projects.create({
      id: 1,
      slug: "backend",
      name: "Backend",
      enabled: true,
      createdAt: NOW,
    });
    projects.setIngestKey({
      projectId: 1,
      environment: "dev",
      publicKey: PUBLIC_KEY,
      allowedOrigins: [],
      forwardingMode: "disabled",
      forwardingSecretRef: null,
      webhookMode: "live",
      webhookTargetUrl: "https://code-agent.example/api/code/webhooks/sentry",
      webhookSecretRef: "HOOK",
      enabledAt: NOW,
      webhookSecrets: { references: () => ["HOOK"] },
    });
    const operations = createOperationsContext();
    operations.storageSafety.observeUsage(safeUsage(), 0, null);
    operations.storageSafety.markSuccess(new Date(NOW), {
      age: 0,
      budget: 0,
    });
    const publicApp = createPublicApp({
      database,
      operations,
      shadowForwarder: { enqueue: () => "disabled" },
      buildOutbox: () => ({
        mode: "live",
        deliveryId: "11111111-1111-4111-8111-111111111111",
        targetUrl: "https://code-agent.example/api/code/webhooks/sentry",
        secretRef: "HOOK",
        signature: "a".repeat(64),
        body: Buffer.from("{}"),
      }),
      now: () => new Date(NOW),
    });
    const privateApp = createPrivateApp({
      database,
      operations,
      privateOrigin: new URL(PRIVATE_ORIGIN),
      organizationSlug: "intexuraos",
      allowedHosts: [PRIVATE_HOST],
      allowedOrigins: [PRIVATE_ORIGIN],
      publicIngestHosts: ["errors.test"],
    });
    apps.push(publicApp, privateApp);

    expect(
      (
        await publicApp.inject({
          method: "POST",
          url: `/api/1/envelope/?sentry_key=${PUBLIC_KEY}`,
          payload: eventEnvelope("11111111111111111111111111111111"),
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await publicApp.inject({
          method: "POST",
          url: `/api/1/envelope/?sentry_key=${PUBLIC_KEY}`,
          payload: unsupportedEnvelope(),
        })
      ).statusCode,
    ).toBe(200);
    await new WebhookDispatcher({
      outbox: new OutboxRepository(database),
      operations,
      http: {
        async send() {
          return { statusCode: 204 };
        },
      },
      now: () => new Date(NOW),
      requestTimeoutMs: 2_000,
      leaseMs: 10_000,
      createLeaseId: () => "shared-lease",
    }).dispatchDue();

    const critical = {
      ...safeUsage(),
      totalBytes: DEFAULT_RETENTION_CONFIG.physicalCriticalBytes,
    };
    operations.storageSafety.observeUsage(
      critical,
      128,
      "2026-08-28T09:00:00.000Z",
    );

    expect(
      (
        await publicApp.inject({
          method: "POST",
          url: `/api/1/envelope/?sentry_key=${PUBLIC_KEY}`,
          payload: eventEnvelope("22222222222222222222222222222222"),
        })
      ).statusCode,
    ).toBe(503);
    const privateHeaders = { host: PRIVATE_HOST };
    expect(
      (
        await privateApp.inject({
          method: "GET",
          url: "/health/ready",
          headers: privateHeaders,
        })
      ).statusCode,
    ).toBe(503);
    expect(
      (
        await privateApp.inject({
          method: "GET",
          url: "/api/system/status",
          headers: privateHeaders,
        })
      ).json(),
    ).toMatchObject({
      status: "critical",
      storage: {
        physicalBytes: DEFAULT_RETENTION_CONFIG.physicalCriticalBytes,
        safety: "critical",
      },
      ingest: { accepting: false },
    });
    const metrics = (
      await privateApp.inject({
        method: "GET",
        url: "/metrics",
        headers: privateHeaders,
      })
    ).body;
    expect(metrics).toContain(
      `error_hub_storage_physical_bytes ${String(DEFAULT_RETENTION_CONFIG.physicalCriticalBytes)}`,
    );
    expect(metrics).toContain(
      'error_hub_ingest_events_total{outcome="accepted"} 1',
    );
    expect(metrics).toContain(
      'error_hub_ingest_events_total{outcome="discarded"} 1',
    );
    expect(metrics).toContain(
      'error_hub_ingest_events_total{outcome="rejected"} 1',
    );
    expect(metrics).toContain('error_hub_grouping_total{outcome="created"} 1');
    expect(metrics).toContain(
      'error_hub_dispatch_total{outcome="delivered"} 1',
    );
  });

  it("uses one tiny retention config for hysteresis, hard limits, admission, and private status", async () => {
    const physicalCriticalBytes = 3 * MAX_UNMEASURED_EVENT_PHYSICAL_BYTES + 101;
    const physicalTotalBytes = physicalCriticalBytes + 25;
    const tinyConfig: RetentionConfig = {
      eventAgeMs: 30 * 24 * 60 * 60_000,
      deliveryTtlMs: 7 * 24 * 60 * 60_000,
      logicalHighBytes: 400,
      logicalTargetBytes: 360,
      physicalCriticalBytes,
      physicalTotalBytes,
      minimumFreeBytes: 10,
      batchSize: 1,
      incrementalVacuumPages: 1,
    };
    const database = openDatabase(":memory:");
    databases.push(database);
    migrateDatabase(database, NOW);
    const projects = new ProjectRepository(database);
    projects.create({
      id: 1,
      slug: "tiny",
      name: "Tiny",
      enabled: true,
      createdAt: NOW,
    });
    projects.setIngestKey({
      projectId: 1,
      environment: "dev",
      publicKey: PUBLIC_KEY,
      allowedOrigins: [],
      forwardingMode: "disabled",
      forwardingSecretRef: null,
      webhookMode: "disabled",
      webhookTargetUrl: null,
      webhookSecretRef: null,
      enabledAt: null,
      webhookSecrets: { references: () => [] },
    });
    const operations = createOperationsContext(tinyConfig);
    expect(operations).toMatchObject({ retentionConfig: tinyConfig });
    const initialUsage = tinyUsage(100);
    operations.storageSafety.observeUsage(initialUsage, 0, null);
    operations.storageSafety.markSuccess(new Date(NOW), {
      age: 0,
      budget: 0,
    });
    const publicApp = createPublicApp({
      database,
      operations,
      shadowForwarder: { enqueue: () => "disabled" },
      buildOutbox: () => ({
        mode: "disabled",
        deliveryId: "22222222-2222-4222-8222-222222222222",
        targetUrl: null,
        secretRef: null,
        signature: null,
        body: Buffer.from("{}"),
      }),
      now: () => new Date(NOW),
    });
    const privateApp = createPrivateApp({
      database,
      operations,
      privateOrigin: new URL(PRIVATE_ORIGIN),
      organizationSlug: "intexuraos",
      allowedHosts: [PRIVATE_HOST],
      allowedOrigins: [PRIVATE_ORIGIN],
      publicIngestHosts: ["errors.test"],
    });
    apps.push(publicApp, privateApp);
    for (const eventId of [
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "cccccccccccccccccccccccccccccccc",
    ]) {
      expect(
        (
          await publicApp.inject({
            method: "POST",
            url: `/api/1/envelope/?sentry_key=${PUBLIC_KEY}`,
            payload: eventEnvelope(eventId),
          })
        ).statusCode,
      ).toBe(200);
    }
    database
      .prepare(
        `UPDATE events
         SET compressed_payload_bytes = CASE event_id
           WHEN 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' THEN 200
           WHEN 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' THEN 201
           ELSE 0
         END`,
      )
      .run();

    const hysteresis = await new RetentionSweeper({
      database,
      operations,
      clock: () => new Date(NOW),
      readPhysicalUsage: () => initialUsage,
      checkpoint: checkpointResult,
      emergencyCheckpoint: checkpointResult,
      incrementalVacuum: () => undefined,
    }).run();

    expect(hysteresis).toMatchObject({
      success: true,
      removedEvents: { age: 0, budget: 1 },
      usage: { logicalPayloadBytes: 201 },
    });
    database
      .prepare(
        `UPDATE events
         SET received_at = '2026-07-01T00:00:00.000Z'
         WHERE event_id = 'cccccccccccccccccccccccccccccccc'`,
      )
      .run();

    operations.storageSafety.observeUsage(
      tinyUsage(physicalCriticalBytes),
      201,
      NOW,
    );
    expect(
      (
        await publicApp.inject({
          method: "POST",
          url: `/api/1/envelope/?sentry_key=${PUBLIC_KEY}`,
          payload: eventEnvelope("dddddddddddddddddddddddddddddddd"),
        })
      ).statusCode,
    ).toBe(503);
    expect(
      (
        await privateApp.inject({
          method: "GET",
          url: "/api/system/status",
          headers: { host: PRIVATE_HOST },
        })
      ).json(),
    ).toMatchObject({
      storage: {
        budgetBytes: physicalTotalBytes,
        logicalHighBytes: 400,
        logicalTargetBytes: 360,
        physicalCriticalBytes,
        minimumFreeBytes: 10,
        safety: "critical",
      },
      ingest: { accepting: false },
    });

    const hardLimit = await new RetentionSweeper({
      database,
      operations,
      clock: () => new Date(NOW),
      readPhysicalUsage: () => tinyUsage(physicalTotalBytes),
      emergencyCheckpoint: checkpointResult,
      incrementalVacuum: () => undefined,
    }).run();
    expect(hardLimit).toMatchObject({
      success: false,
      failure: "physical_storage_critical",
      removedEvents: { age: 0, budget: 0 },
    });
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM events").get(),
    ).toEqual({ count: 2 });
  });
});

function eventEnvelope(eventId: string): Buffer {
  const payload = Buffer.from(
    JSON.stringify({
      event_id: eventId,
      environment: "dev",
      level: "error",
      platform: "node",
      timestamp: NOW,
      message: "shared operations failure",
      server_name: "api",
    }),
  );
  return Buffer.concat([
    Buffer.from(`${JSON.stringify({ event_id: eventId })}\n`),
    Buffer.from(
      `${JSON.stringify({ type: "event", length: payload.length })}\n`,
    ),
    payload,
  ]);
}

function unsupportedEnvelope(): Buffer {
  const payload = Buffer.from("{}");
  return Buffer.concat([
    Buffer.from("{}\n"),
    Buffer.from(
      `${JSON.stringify({ type: "client_report", length: payload.length })}\n`,
    ),
    payload,
  ]);
}

function safeUsage() {
  return {
    databaseBytes: 100,
    walBytes: 20,
    shmBytes: 10,
    temporaryBytes: 5,
    dataDirectoryOtherBytes: 0,
    totalBytes: 135,
    freeBytes: 10 * 1024 ** 3,
  };
}

function tinyUsage(totalBytes: number): PhysicalStorageUsage {
  return {
    databaseBytes: totalBytes,
    walBytes: 0,
    shmBytes: 0,
    temporaryBytes: 0,
    dataDirectoryOtherBytes: 0,
    totalBytes,
    freeBytes: 10 * MAX_UNMEASURED_EVENT_PHYSICAL_BYTES,
  };
}

function checkpointResult() {
  return { busy: 0, logFrames: 0, checkpointedFrames: 0 };
}

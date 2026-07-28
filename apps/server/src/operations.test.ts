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
import { DEFAULT_RETENTION_CONFIG } from "./retention/storage-budget.js";

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

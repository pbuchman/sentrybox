import { createServer, request, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { startRuntime, type ErrorHubRuntime } from "../../src/runtime.js";
import { openDatabase } from "../../src/storage/database.js";
import { migrateDatabase } from "../../src/storage/migrate.js";
import { ProjectRepository } from "../../src/storage/project-repository.js";
import { signWebhookBody } from "../../src/webhooks/signature.js";
import type { WebhookHttpRequest } from "../../src/webhooks/dispatcher.js";
import {
  NODE_EVENT_ID,
  PUBLIC_KEY,
  WEB_PUBLIC_KEY,
  browserEnvelope855,
  browserFixtureEnvelopeGzip,
  nodeEnvelope855,
  nodeFixtureEnvelope,
} from "./fixtures.js";

const privateOrigin = "https://hub.test:8443";
const temporaryDirectories: string[] = [];
const runtimes: ErrorHubRuntime[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const runtime of runtimes.splice(0).reverse()) await runtime.close();
  for (const server of servers.splice(0).reverse()) await closeServer(server);
  for (const directory of temporaryDirectories.splice(0).reverse()) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("Error Hub real-network end to end", () => {
  it.each([1, 2])(
    "runs the complete sanitized SDK/runtime flow twice in one process (run %s)",
    async (run) => {
      const forbidden = [
        `Bearer-${randomUUID()}`,
        `cookie-${randomUUID()}`,
        `password-${randomUUID()}`,
        `token-${randomUUID()}`,
      ];
      const webhookSecret = `webhook-${randomUUID()}`;
      const nodeSecondId = (run === 1 ? "3" : "4").repeat(32);
      const browserId = (run === 1 ? "6" : "7").repeat(32);
      const debugId = (run === 1 ? "8" : "9").repeat(32);
      const infoId = (run === 1 ? "a" : "b").repeat(32);
      const unknownReleaseId = (run === 1 ? "c" : "d").repeat(32);
      const requestId = `req-task-11-${String(run)}`;
      const directory = await mkdtemp(join(tmpdir(), "error-hub-e2e-"));
      temporaryDirectories.push(directory);
      const databasePath = join(directory, "error-hub.sqlite");
      await writeFile(join(directory, "index.html"), "<h1>Error Hub</h1>");
      const receivedWebhooks: ReceivedWebhook[] = [];
      const webhookServer = createServer((incoming, outgoing) => {
        const chunks: Buffer[] = [];
        incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
        incoming.once("end", () => {
          receivedWebhooks.push({
            body: Buffer.concat(chunks),
            headers: incoming.headers,
          });
          outgoing.writeHead(204).end();
        });
      });
      servers.push(webhookServer);
      const webhookOrigin = await listen(webhookServer);
      const webhookTargets: string[] = [];
      const secrets = {
        references: () => ["error-hub-webhook"],
        resolve: (reference: string) => {
          if (reference !== "error-hub-webhook") throw new Error("unknown ref");
          return webhookSecret;
        },
      };

      seedProject(databasePath, secrets);
      const runtime = await startRuntime({
        databasePath,
        dataDirectory: directory,
        staticRoot: directory,
        publicListener: { port: 0 },
        privateListener: { port: 0 },
        privateOrigin: new URL(privateOrigin),
        organizationSlug: "intexuraos",
        allowedHosts: ["hub.test:8443"],
        allowedOrigins: [privateOrigin],
        publicIngestHosts: ["errors.test"],
        secrets,
        readPhysicalUsage: () => safeUsage(),
        cadence: { dispatchMs: 10, physicalMonitorMs: 50 },
        webhookHttp: {
          async send(webhookRequest) {
            webhookTargets.push(webhookRequest.targetUrl.toString());
            return sendToRealWebhookListener(webhookOrigin, webhookRequest);
          },
        },
      });
      runtimes.push(runtime);

      expect(nodeEnvelope855.toString("utf8")).toContain(
        '"name":"sentry.javascript.node","version":"8.55.0"',
      );
      expect(browserEnvelope855.toString("utf8")).toContain(
        '"name":"sentry.javascript.react","version":"8.55.0"',
      );
      const firstNode = nodeFixtureEnvelope({
        eventId: NODE_EVENT_ID,
        timestampSeconds: seconds("2026-07-29T12:00:00.000Z"),
        release: "fixture-node@1.0.0",
        service: "runtime-service",
        requestId,
        forbiddenValues: forbidden,
      });
      const browser = browserFixtureEnvelopeGzip({
        eventId: browserId,
        timestampSeconds: seconds("2026-07-29T12:01:00.000Z"),
        release: "fixture-browser@1.0.0",
        service: "browser-service",
        forbiddenValues: forbidden,
      });
      const backendIngestUrl = new URL(
        `/api/1/envelope/?sentry_key=${PUBLIC_KEY}`,
        runtime.publicUrl,
      );
      const webIngestUrl = new URL(
        `/api/2/envelope/?sentry_key=${WEB_PUBLIC_KEY}`,
        runtime.publicUrl,
      );

      expect((await ingest(backendIngestUrl, firstNode)).status).toBe(200);
      expect((await ingest(backendIngestUrl, firstNode)).status).toBe(200);
      expect(
        (
          await ingest(webIngestUrl, browser, {
            "content-encoding": "gzip",
            origin: "https://browser.test",
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await ingest(
            backendIngestUrl,
            nodeFixtureEnvelope({
              eventId: unknownReleaseId,
              timestampSeconds: seconds("2026-07-29T12:00:30.000Z"),
              release: null,
              service: "runtime-service",
              requestId,
              forbiddenValues: forbidden,
            }),
          )
        ).status,
      ).toBe(200);
      expect(
        (
          await ingest(
            new URL(
              `/api/1/envelope/?sentry_key=${WEB_PUBLIC_KEY}`,
              runtime.publicUrl,
            ),
            firstNode,
          )
        ).status,
      ).toBe(400);
      expect(
        (
          await ingest(
            new URL(
              `/api/2/envelope/?sentry_key=${PUBLIC_KEY}`,
              runtime.publicUrl,
            ),
            browser,
            { "content-encoding": "gzip", origin: "https://browser.test" },
          )
        ).status,
      ).toBe(400);
      expect(
        (
          await ingest(
            backendIngestUrl,
            nodeFixtureEnvelope({
              eventId: debugId,
              timestampSeconds: seconds("2026-07-29T12:02:00.000Z"),
              release: "fixture-node@1.0.0",
              service: "runtime-service",
              level: "debug",
              forbiddenValues: forbidden,
            }),
          )
        ).status,
      ).toBe(200);
      expect(
        (
          await ingest(
            backendIngestUrl,
            nodeFixtureEnvelope({
              eventId: infoId,
              timestampSeconds: seconds("2026-07-29T12:03:00.000Z"),
              release: "fixture-node@1.0.0",
              service: "runtime-service",
              level: "info",
              forbiddenValues: forbidden,
            }),
          )
        ).status,
      ).toBe(200);
      await waitUntil(() => receivedWebhooks.length === 2);

      const issues = await privateJson<{
        items: Array<{
          id: number;
          count: number;
          project: { slug: string };
          status: string;
        }>;
      }>(runtime, "/api/issues");
      expect(issues.items).toHaveLength(2);
      const nodeIssue = required(
        issues.items.find(
          (issue) => issue.project.slug === "intexuraos-backend",
        ),
        "node issue",
      );
      const browserIssue = required(
        issues.items.find((issue) => issue.project.slug === "intexuraos-web"),
        "browser issue",
      );
      expect(nodeIssue.project.slug).toBe("intexuraos-backend");
      expect(nodeIssue.status).toBe("unresolved");
      expect(nodeIssue.count).toBe(2);
      expect(browserIssue.count).toBe(1);
      await expectIssueFilter(runtime, "project=intexuraos-backend", [
        nodeIssue.id,
      ]);
      await expectIssueFilter(runtime, "project=intexuraos-web", [
        browserIssue.id,
      ]);
      await expectIssueFilter(runtime, "project=missing", []);
      await expectIssueFilter(runtime, "release=fixture-node%401.0.0", [
        nodeIssue.id,
      ]);
      await expectIssueFilter(runtime, "release=~v1%3An", [nodeIssue.id]);
      await expectIssueFilter(runtime, "release=missing", []);
      await expectIssueFilter(runtime, "environment=fixture", [
        nodeIssue.id,
        browserIssue.id,
      ]);
      await expectIssueFilter(runtime, "environment=prod", []);
      await expectIssueFilter(runtime, "service=runtime-service", [
        nodeIssue.id,
      ]);
      await expectIssueFilter(runtime, "service=browser-service", [
        browserIssue.id,
      ]);
      await expectIssueFilter(runtime, "service=missing", []);
      await expectIssueFilter(runtime, "level=error", [
        nodeIssue.id,
        browserIssue.id,
      ]);
      await expectIssueFilter(runtime, "level=warn", []);
      await expectIssueFilter(runtime, "status=unresolved", [
        nodeIssue.id,
        browserIssue.id,
      ]);
      await expectIssueFilter(runtime, "status=resolved", []);
      await expectIssueFilter(
        runtime,
        "from=2026-07-29T11%3A59%3A59.000Z&to=2026-07-29T12%3A00%3A31.000Z",
        [nodeIssue.id],
      );
      await expectIssueFilter(runtime, "from=2026-07-29T12%3A02%3A00.000Z", []);
      await expectIssueFilter(runtime, "query=node%20fixture%20exception", [
        nodeIssue.id,
      ]);
      await expectIssueFilter(runtime, "query=missing%20exception", []);
      await expectIssueFilter(
        runtime,
        "project=intexuraos-backend&release=fixture-node%401.0.0&environment=fixture&service=runtime-service&level=error&status=unresolved&from=2026-07-29T11%3A59%3A59.000Z&to=2026-07-29T12%3A00%3A01.000Z&query=node",
        [nodeIssue.id],
      );
      const facets = await privateJson<{
        release: Array<{ value: string; count: number }>;
        environment: Array<{ value: string; count: number }>;
        status: Array<{ value: string; count: number }>;
      }>(runtime, "/api/facets");
      expect(facets.release).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ value: "fixture-node@1.0.0", count: 1 }),
          expect.objectContaining({ value: "fixture-browser@1.0.0", count: 1 }),
        ]),
      );
      expect(facets.environment).toContainEqual(
        expect.objectContaining({ value: "fixture", count: 3 }),
      );
      expect(facets.status).toContainEqual(
        expect.objectContaining({ value: "unresolved", count: 3 }),
      );

      const occurrences = await privateJson<{
        items: Array<{ rowId: number; id: string; requestId: string | null }>;
      }>(runtime, `/api/issues/${String(nodeIssue.id)}/events`);
      expect(occurrences.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: NODE_EVENT_ID, requestId }),
          expect.objectContaining({ id: unknownReleaseId, requestId }),
        ]),
      );
      const firstNodeOccurrence = required(
        occurrences.items.find((event) => event.id === NODE_EVENT_ID),
        "first node occurrence",
      );
      const event = await privateJson<{
        eventId: string;
        logLocator: { confidence: string; query: string };
      }>(runtime, `/api/events/${String(firstNodeOccurrence.rowId)}`);
      expect(event.eventId).toBe(NODE_EVENT_ID);
      expect(event.logLocator).toEqual(
        expect.objectContaining({ confidence: "exact_identifier" }),
      );
      expect(JSON.stringify(event.logLocator)).toContain(
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      );

      const resolved = await privateRequest(
        runtime,
        `/api/issues/${String(nodeIssue.id)}/resolve`,
        { method: "POST", mutation: true },
      );
      expect(resolved.status).toBe(200);
      expect((await resolved.json()) as { status: string }).toMatchObject({
        status: "resolved",
      });
      expect(
        (
          await privateJson<{ items: unknown[] }>(
            runtime,
            "/api/issues?status=resolved",
          )
        ).items,
      ).toHaveLength(1);

      expect(
        (
          await ingest(
            backendIngestUrl,
            nodeFixtureEnvelope({
              eventId: nodeSecondId,
              timestampSeconds: seconds("2026-07-29T12:04:00.000Z"),
              release: "fixture-node@1.1.0",
              service: "runtime-service",
              requestId,
              forbiddenValues: forbidden,
            }),
          )
        ).status,
      ).toBe(200);
      await waitUntil(() => receivedWebhooks.length === 3);
      const detail = await privateJson<{
        status: string;
        generation: number;
        count: number;
        deliveries: Array<{ generation: number; state: string }>;
      }>(runtime, `/api/issues/${String(nodeIssue.id)}`);
      expect(detail).toMatchObject({
        status: "unresolved",
        generation: 2,
        count: 3,
      });
      expect(detail.deliveries).toEqual([
        expect.objectContaining({ generation: 1, state: "delivered" }),
        expect.objectContaining({ generation: 2, state: "delivered" }),
      ]);

      expect(webhookTargets).toEqual([
        "https://code-agent.test/api/code/webhooks/sentry",
        "https://code-agent.test/api/code/webhooks/sentry",
        "https://code-agent.test/api/code/webhooks/sentry",
      ]);
      for (const delivery of receivedWebhooks) {
        const body = delivery.body.toString("utf8");
        const parsed = JSON.parse(body) as {
          action: string;
          data: { event: { web_url: string; issue: { permalink: string } } };
        };
        expect(parsed.action).toBe("triggered");
        expect(parsed.data.event.web_url).toMatch(
          /^https:\/\/hub\.test:8443\/organizations\/intexuraos\/issues\/\d+\/events\/[0-9]+\/$/u,
        );
        expect(parsed.data.event.issue.permalink).toMatch(
          /^https:\/\/hub\.test:8443\/organizations\/intexuraos\/issues\/\d+\/$/u,
        );
        expect(delivery.headers["content-type"]).toBe("application/json");
        expect(delivery.headers["sentry-hook-resource"]).toBe("event_alert");
        expect(delivery.headers["sentry-hook-signature"]).toBe(
          signWebhookBody(delivery.body, webhookSecret),
        );
        expect(delivery.headers["x-error-hub-delivery"]).toMatch(
          /^[0-9a-f-]{36}$/u,
        );
      }

      const eventDownload = await privateRequest(
        runtime,
        `/api/events/${String(firstNodeOccurrence.rowId)}/download`,
      );
      expect(eventDownload.status).toBe(200);
      const downloadedEvent = (await eventDownload.json()) as { id: string };
      expect(downloadedEvent).toMatchObject({
        id: NODE_EVENT_ID,
      });
      const issueDownload = await privateRequest(
        runtime,
        `/api/issues/${String(nodeIssue.id)}/download`,
      );
      expect(issueDownload.headers.get("content-encoding")).toBe("gzip");
      const downloadedIssue = parseGzipNdjson(
        await issueDownload.arrayBuffer(),
      );
      expect(downloadedIssue).toHaveLength(3);
      const exported = await privateRequest(
        runtime,
        "/api/export?release=fixture-node%401.1.0",
      );
      const exportedEvents = parseGzipNdjson(await exported.arrayBuffer());
      expect(exportedEvents).toEqual([
        expect.objectContaining({ id: nodeSecondId }),
      ]);
      const serializedDownloads = JSON.stringify([
        downloadedEvent,
        downloadedIssue,
        exportedEvents,
      ]);
      for (const value of [...forbidden, webhookSecret]) {
        expect(serializedDownloads).not.toContain(value);
      }

      for (const path of [
        "/",
        `/organizations/intexuraos/issues/${String(nodeIssue.id)}/`,
        "/api/issues",
        "/api/export",
        "/api/0/organizations/intexuraos/issues/1/",
        "/assets/app.js",
      ]) {
        expect((await fetch(new URL(path, runtime.publicUrl))).status).toBe(
          404,
        );
      }
      const deleted = await privateRequest(
        runtime,
        `/api/issues/${String(nodeIssue.id)}`,
        { method: "DELETE", mutation: true },
      );
      expect(deleted.status, await deleted.clone().text()).toBe(204);
      expect(
        (await privateRequest(runtime, `/api/issues/${String(nodeIssue.id)}`))
          .status,
      ).toBe(404);

      await runtime.close();
      runtimes.pop();
      await closeServer(webhookServer);
      servers.pop();
      const persisted = openDatabase(databasePath);
      const eventRows = persisted
        .prepare("SELECT event_id, payload_gzip FROM events ORDER BY id")
        .all() as Array<{ event_id: string; payload_gzip: Buffer }>;
      expect(eventRows).toHaveLength(1);
      expect(eventRows.map((row) => row.event_id)).not.toContain(debugId);
      expect(eventRows.map((row) => row.event_id)).not.toContain(infoId);
      const searchableStorage = Buffer.concat([
        await readFile(databasePath),
        ...eventRows.map((row) => gunzipSync(row.payload_gzip)),
      ]).toString("utf8");
      for (const value of [...forbidden, webhookSecret]) {
        expect(searchableStorage).not.toContain(value);
      }
      expect(
        persisted.prepare("SELECT COUNT(*) AS count FROM webhook_outbox").get(),
      ).toEqual({ count: 1 });
      persisted.close();
    },
    20_000,
  );
});

interface ReceivedWebhook {
  readonly body: Buffer;
  readonly headers: import("node:http").IncomingHttpHeaders;
}

function seedProject(
  databasePath: string,
  secrets: { references(): readonly string[] },
): void {
  const database = openDatabase(databasePath);
  migrateDatabase(database, "2026-07-29T11:00:00.000Z");
  const projects = new ProjectRepository(database);
  projects.create({
    id: 1,
    slug: "intexuraos-backend",
    name: "IntexuraOS backend",
    enabled: true,
    createdAt: "2026-07-29T11:00:00.000Z",
  });
  projects.setIngestKey({
    projectId: 1,
    environment: "fixture",
    publicKey: PUBLIC_KEY,
    allowedOrigins: [],
    forwardingMode: "disabled",
    forwardingSecretRef: null,
    webhookMode: "live",
    webhookTargetUrl: "https://code-agent.test/api/code/webhooks/sentry",
    webhookSecretRef: "error-hub-webhook",
    enabledAt: "2026-07-29T11:00:00.000Z",
    webhookSecrets: secrets,
  });
  projects.create({
    id: 2,
    slug: "intexuraos-web",
    name: "IntexuraOS web",
    enabled: true,
    createdAt: "2026-07-29T11:00:00.000Z",
  });
  projects.setIngestKey({
    projectId: 2,
    environment: "fixture",
    publicKey: WEB_PUBLIC_KEY,
    allowedOrigins: ["https://browser.test"],
    forwardingMode: "disabled",
    forwardingSecretRef: null,
    webhookMode: "live",
    webhookTargetUrl: "https://code-agent.test/api/code/webhooks/sentry",
    webhookSecretRef: "error-hub-webhook",
    enabledAt: "2026-07-29T11:00:00.000Z",
    webhookSecrets: secrets,
  });
  database.close();
}

async function expectIssueFilter(
  runtime: ErrorHubRuntime,
  query: string,
  expectedIds: readonly number[],
): Promise<void> {
  const result = await privateJson<{ items: Array<{ id: number }> }>(
    runtime,
    `/api/issues?${query}`,
  );
  expect(
    result.items.map((issue) => issue.id).sort((left, right) => left - right),
  ).toEqual([...expectedIds].sort((left, right) => left - right));
}

function ingest(
  url: URL,
  body: Buffer,
  headers: Readonly<Record<string, string>> = {},
): Promise<Response> {
  return fetch(url, { method: "POST", headers, body });
}

async function privateJson<T>(
  runtime: ErrorHubRuntime,
  path: string,
): Promise<T> {
  const response = await privateRequest(runtime, path);
  expect(response.status).toBe(200);
  return (await response.json()) as T;
}

function privateRequest(
  runtime: ErrorHubRuntime,
  path: string,
  options: { readonly method?: string; readonly mutation?: boolean } = {},
): Promise<Response> {
  const url = new URL(path, runtime.privateUrl);
  const headers: Record<string, string> = { Host: "hub.test:8443" };
  if (options.mutation === true) {
    headers.Origin = privateOrigin;
    headers["Content-Type"] = "application/json";
    headers["Content-Length"] = "2";
  }
  return new Promise<Response>((resolveResponse, rejectResponse) => {
    const outgoing = request(url, {
      method: options.method ?? "GET",
      headers,
    });
    outgoing.once("response", (incoming) => {
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
      incoming.once("end", () => {
        const status = incoming.statusCode ?? 500;
        resolveResponse(
          new Response(
            [204, 205, 304].includes(status) ? null : Buffer.concat(chunks),
            {
              status,
              headers: incoming.headers as Record<string, string>,
            },
          ),
        );
      });
    });
    outgoing.once("error", rejectResponse);
    if (options.mutation === true) {
      outgoing.end("{}");
    } else {
      outgoing.end();
    }
  });
}

function sendToRealWebhookListener(
  origin: URL,
  webhook: WebhookHttpRequest,
): Promise<{ readonly statusCode: number }> {
  return new Promise((resolveResponse, rejectResponse) => {
    const outgoing = request(origin, {
      method: "POST",
      headers: { ...webhook.headers, "content-length": webhook.body.length },
    });
    outgoing.once("response", (incoming) => {
      incoming.resume();
      incoming.once("end", () =>
        resolveResponse({ statusCode: incoming.statusCode ?? 500 }),
      );
    });
    outgoing.once("error", rejectResponse);
    outgoing.end(webhook.body);
  });
}

async function listen(server: Server): Promise<URL> {
  await new Promise<void>((resolveListen) =>
    server.listen(0, "127.0.0.1", resolveListen),
  );
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("webhook listener address is unavailable");
  }
  return new URL(`http://127.0.0.1:${String(address.port)}/`);
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolveClose, rejectClose) =>
    server.close((error) =>
      error === undefined ? resolveClose() : rejectClose(error),
    ),
  );
}

async function waitUntil(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error("timed out waiting for runtime background work");
}

function parseGzipNdjson(value: ArrayBuffer): unknown[] {
  return gunzipSync(Buffer.from(value))
    .toString("utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown);
}

function seconds(timestamp: string): number {
  return Date.parse(timestamp) / 1_000;
}

function required<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new Error(`${name} is missing`);
  return value;
}

function safeUsage() {
  return {
    databaseBytes: 0,
    walBytes: 0,
    shmBytes: 0,
    temporaryBytes: 0,
    dataDirectoryOtherBytes: 0,
    totalBytes: 0,
    freeBytes: 10 * 1024 ** 3,
  };
}

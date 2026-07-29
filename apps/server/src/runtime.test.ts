import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectRepository } from "./storage/project-repository.js";
import { migrateDatabase } from "./storage/migrate.js";
import { openDatabase } from "./storage/database.js";
import { nodeEnvelope855, PUBLIC_KEY } from "../test/e2e/fixtures.js";
import {
  RuntimeShutdownError,
  startRuntime,
  type ErrorHubRuntime,
} from "./runtime.js";
import { MAX_UNMEASURED_EVENT_PHYSICAL_BYTES } from "./retention/storage-budget.js";

const temporaryDirectories: string[] = [];
const runtimes: ErrorHubRuntime[] = [];

afterEach(async () => {
  for (const runtime of runtimes.splice(0).reverse()) await runtime.close();
  for (const directory of temporaryDirectories.splice(0).reverse()) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("Error Hub runtime", () => {
  it("starts independent ephemeral loopback listeners and closes idempotently", async () => {
    const directory = await mkdtemp(join(tmpdir(), "error-hub-runtime-"));
    temporaryDirectories.push(directory);
    await writeFile(join(directory, "index.html"), "<h1>Error Hub</h1>");

    const runtime = await startRuntime({
      databasePath: join(directory, "error-hub.sqlite"),
      dataDirectory: directory,
      staticRoot: directory,
      publicListener: { port: 0 },
      privateListener: { port: 0 },
      privateOrigin: new URL("https://hub.test:8443"),
      organizationSlug: "intexuraos",
      allowedHosts: ["hub.test:8443"],
      allowedOrigins: ["https://hub.test:8443"],
      publicIngestHosts: ["errors.test"],
      secrets: { references: () => [], resolve: () => "unused" },
      readPhysicalUsage: () => safeUsage(),
    });
    runtimes.push(runtime);

    expect(runtime.publicUrl.hostname).toBe("127.0.0.1");
    expect(runtime.privateUrl.hostname).toBe("127.0.0.1");
    expect(runtime.publicUrl.port).not.toBe(runtime.privateUrl.port);
    expect(
      (await fetch(new URL("/health/live", runtime.publicUrl))).status,
    ).toBe(200);

    await runtime.close();
    await runtime.close();
    runtimes.pop();
  });

  it("rejects listeners resolving to the same address and port before touching storage", async () => {
    const directory = await mkdtemp(join(tmpdir(), "error-hub-collision-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "must-not-exist.sqlite");
    const port = await availablePort();

    await expect(
      startRuntime({
        ...baseOptions(directory, databasePath),
        publicListener: { host: "localhost", port },
        privateListener: { host: "127.0.0.1", port },
      }),
    ).rejects.toThrow("independent");
    await expect(access(databasePath)).rejects.toThrow();
  });

  it("reserves cadence-independent physical headroom until a stable monitor sample", async () => {
    const directory = await mkdtemp(join(tmpdir(), "error-hub-headroom-"));
    temporaryDirectories.push(directory);
    await writeFile(join(directory, "index.html"), "<h1>Error Hub</h1>");
    const databasePath = join(directory, "error-hub.sqlite");
    const database = openDatabase(databasePath);
    migrateDatabase(database, "2026-07-29T12:00:00.000Z");
    const projects = new ProjectRepository(database);
    projects.create({
      id: 1,
      slug: "runtime",
      name: "Runtime",
      enabled: true,
      createdAt: "2026-07-29T12:00:00.000Z",
    });
    projects.setIngestKey({
      projectId: 1,
      environment: "fixture",
      publicKey: PUBLIC_KEY,
      allowedOrigins: [],
      forwardingMode: "disabled",
      forwardingSecretRef: null,
      webhookMode: "disabled",
      webhookTargetUrl: null,
      webhookSecretRef: null,
      enabledAt: null,
    });
    database.close();
    const runtime = await startRuntime({
      ...baseOptions(directory, databasePath),
      cadence: { physicalMonitorMs: 500 },
      retentionConfig: {
        eventAgeMs: 1_000,
        deliveryTtlMs: 1_000,
        logicalHighBytes: 1_000_000,
        logicalTargetBytes: 900_000,
        physicalCriticalBytes: 4 * MAX_UNMEASURED_EVENT_PHYSICAL_BYTES,
        physicalTotalBytes:
          4 * MAX_UNMEASURED_EVENT_PHYSICAL_BYTES + 256 * 1024 ** 2,
        minimumFreeBytes: 10,
        batchSize: 1,
        incrementalVacuumPages: 1,
      },
      readPhysicalUsage: () => ({
        ...safeUsage(),
        totalBytes: 3 * MAX_UNMEASURED_EVENT_PHYSICAL_BYTES - 1,
      }),
    });
    runtimes.push(runtime);
    const endpoint = new URL(
      `/api/1/envelope/?sentry_key=${PUBLIC_KEY}`,
      runtime.publicUrl,
    );

    expect(
      (await fetch(endpoint, { method: "POST", body: nodeEnvelope855 })).status,
    ).toBe(200);
    expect(
      (await fetch(endpoint, { method: "POST", body: nodeEnvelope855 })).status,
    ).toBe(503);
    await waitUntil(
      async () =>
        (await fetch(endpoint, { method: "POST", body: nodeEnvelope855 }))
          .status === 200,
    );
  });

  it("fails readiness and ingest after a sampler failure, then recovers on a stable sample", async () => {
    const directory = await mkdtemp(join(tmpdir(), "error-hub-monitor-"));
    temporaryDirectories.push(directory);
    await writeFile(join(directory, "index.html"), "<h1>Error Hub</h1>");
    const databasePath = join(directory, "error-hub.sqlite");
    seedRuntimeProject(databasePath);
    let sampler: "safe" | "failed" = "safe";
    const failureSecret = "runtime-sampler-secret";
    const runtime = await startRuntime({
      ...baseOptions(directory, databasePath),
      cadence: { physicalMonitorMs: 10 },
      readPhysicalUsage: () => {
        if (sampler === "failed") throw new Error(failureSecret);
        return safeUsage();
      },
    });
    runtimes.push(runtime);
    sampler = "failed";

    await waitUntil(
      async () =>
        (await runtimePrivateRequest(runtime, "/health/ready")).status === 503,
    );
    const status = await runtimePrivateRequest(runtime, "/api/system/status");
    const statusText = await status.text();
    expect(statusText).toContain('"healthy":false');
    expect(statusText).not.toContain(failureSecret);
    const metrics = await runtimePrivateRequest(runtime, "/metrics");
    expect(await metrics.text()).toContain(
      'sentrybox_physical_monitor_samples_total{outcome="failure"}',
    );
    const endpoint = new URL(
      `/api/1/envelope/?sentry_key=${PUBLIC_KEY}`,
      runtime.publicUrl,
    );
    expect(
      (await fetch(endpoint, { method: "POST", body: nodeEnvelope855 })).status,
    ).toBe(503);

    sampler = "safe";
    await waitUntil(
      async () =>
        (await runtimePrivateRequest(runtime, "/health/ready")).status === 200,
    );
    expect(
      (await fetch(endpoint, { method: "POST", body: nodeEnvelope855 })).status,
    ).toBe(200);
  });

  it("aborts a hanging physical sample and closes both listeners and SQLite within the shutdown bound", async () => {
    const directory = await mkdtemp(join(tmpdir(), "error-hub-shutdown-"));
    temporaryDirectories.push(directory);
    await writeFile(join(directory, "index.html"), "<h1>Error Hub</h1>");
    const databasePath = join(directory, "error-hub.sqlite");
    let hang = false;
    let sampleStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      sampleStarted = resolve;
    });
    const runtime = await startRuntime({
      ...baseOptions(directory, databasePath),
      cadence: { physicalMonitorMs: 1 },
      shutdownTimeoutMs: 100,
      readPhysicalUsage: (signal?: AbortSignal) => {
        if (!hang) return safeUsage();
        sampleStarted?.();
        return new Promise<ReturnType<typeof safeUsage>>((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => reject(new Error("sample aborted")),
            { once: true },
          );
        });
      },
    });
    runtimes.push(runtime);
    hang = true;
    await started;
    const publicUrl = new URL(runtime.publicUrl);
    const privateUrl = new URL(runtime.privateUrl);
    const closeStarted = Date.now();

    await expect(
      Promise.race([
        runtime.close().then(() => "closed"),
        new Promise<string>((resolve) =>
          setTimeout(() => resolve("timed_out"), 400),
        ),
      ]),
    ).resolves.toBe("closed");
    expect(Date.now() - closeStarted).toBeLessThan(400);
    runtimes.pop();
    await expect(fetch(new URL("/health/live", publicUrl))).rejects.toThrow();
    await expect(fetch(new URL("/health/live", privateUrl))).rejects.toThrow();
    const reopened = openDatabase(databasePath);
    expect(reopened.open).toBe(true);
    reopened.close();
    await expect(runtime.close()).resolves.toBeUndefined();
  });

  it("replays the exact failed shutdown after a hanging live webhook without rerunning cleanup", async () => {
    const directory = await mkdtemp(join(tmpdir(), "error-hub-failed-close-"));
    temporaryDirectories.push(directory);
    await writeFile(join(directory, "index.html"), "<h1>Error Hub</h1>");
    const databasePath = join(directory, "error-hub.sqlite");
    const webhookSecret = "runtime-webhook-secret";
    seedLiveRuntimeProject(databasePath, webhookSecret);
    let markSendStarted: (() => void) | undefined;
    const sendStarted = new Promise<void>((resolve) => {
      markSendStarted = resolve;
    });
    const runtime = await startRuntime({
      ...baseOptions(directory, databasePath),
      cadence: { dispatchMs: 1 },
      shutdownTimeoutMs: 50,
      secrets: {
        references: () => [webhookSecret],
        resolve: () => "signing-secret",
      },
      webhookHttp: {
        async send() {
          markSendStarted?.();
          return new Promise<never>(() => undefined);
        },
      },
    });
    const ingest = await fetch(
      new URL(`/api/1/envelope/?sentry_key=${PUBLIC_KEY}`, runtime.publicUrl),
      { method: "POST", body: nodeEnvelope855 },
    );
    expect(ingest.status).toBe(200);
    await sendStarted;

    const firstClose = runtime.close();
    const firstFailure = await firstClose.catch((error: unknown) => error);
    expect(firstFailure).toBeInstanceOf(RuntimeShutdownError);
    expect(
      (firstFailure as RuntimeShutdownError).errors.map(
        (error) => error.message,
      ),
    ).toEqual([
      "close runtime loops: close runtime loops exceeded its shutdown deadline",
    ]);
    const secondClose = runtime.close();
    expect(secondClose).toBe(firstClose);
    const secondFailure = await secondClose.catch((error: unknown) => error);
    expect(secondFailure).toBe(firstFailure);
    expect(
      (secondFailure as RuntimeShutdownError).errors.map(
        (error) => error.message,
      ),
    ).toEqual([
      "close runtime loops: close runtime loops exceeded its shutdown deadline",
    ]);

    const reopened = openDatabase(databasePath);
    expect(reopened.open).toBe(true);
    reopened.close();
  });
});

function seedRuntimeProject(databasePath: string): void {
  const database = openDatabase(databasePath);
  migrateDatabase(database, "2026-07-29T12:00:00.000Z");
  const projects = new ProjectRepository(database);
  projects.create({
    id: 1,
    slug: "runtime",
    name: "Runtime",
    enabled: true,
    createdAt: "2026-07-29T12:00:00.000Z",
  });
  projects.setIngestKey({
    projectId: 1,
    environment: "fixture",
    publicKey: PUBLIC_KEY,
    allowedOrigins: [],
    forwardingMode: "disabled",
    forwardingSecretRef: null,
    webhookMode: "disabled",
    webhookTargetUrl: null,
    webhookSecretRef: null,
    enabledAt: null,
  });
  database.close();
}

function seedLiveRuntimeProject(
  databasePath: string,
  webhookSecret: string,
): void {
  const database = openDatabase(databasePath);
  migrateDatabase(database, "2026-07-29T12:00:00.000Z");
  const projects = new ProjectRepository(database);
  projects.create({
    id: 1,
    slug: "runtime",
    name: "Runtime",
    enabled: true,
    createdAt: "2026-07-29T12:00:00.000Z",
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
    webhookSecretRef: webhookSecret,
    enabledAt: "2026-07-29T12:00:00.000Z",
    webhookSecrets: { references: () => [webhookSecret] },
  });
  database.close();
}

function baseOptions(directory: string, databasePath: string) {
  return {
    databasePath,
    dataDirectory: directory,
    staticRoot: directory,
    publicListener: { port: 0 },
    privateListener: { port: 0 },
    privateOrigin: new URL("https://hub.test:8443"),
    organizationSlug: "intexuraos",
    allowedHosts: ["hub.test:8443"],
    allowedOrigins: ["https://hub.test:8443"],
    publicIngestHosts: ["errors.test"],
    secrets: { references: () => [], resolve: () => "unused" },
    readPhysicalUsage: () => safeUsage(),
  };
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen) =>
    server.listen(0, "127.0.0.1", resolveListen),
  );
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("test listener address is unavailable");
  }
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  return address.port;
}

async function waitUntil(condition: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await condition()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error("condition was not met");
}

function runtimePrivateRequest(
  runtime: ErrorHubRuntime,
  path: string,
): Promise<Response> {
  const url = new URL(path, runtime.privateUrl);
  return new Promise((resolveResponse, rejectResponse) => {
    const outgoing = request(url, { headers: { Host: "hub.test:8443" } });
    outgoing.once("response", (incoming) => {
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
      incoming.once("end", () => {
        resolveResponse(
          new Response(Buffer.concat(chunks), {
            status: incoming.statusCode ?? 500,
            headers: incoming.headers as Record<string, string>,
          }),
        );
      });
    });
    outgoing.once("error", rejectResponse);
    outgoing.end();
  });
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

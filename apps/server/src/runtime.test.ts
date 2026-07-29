import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectRepository } from "./storage/project-repository.js";
import { migrateDatabase } from "./storage/migrate.js";
import { openDatabase } from "./storage/database.js";
import { nodeEnvelope855, PUBLIC_KEY } from "../test/e2e/fixtures.js";
import { startRuntime, type ErrorHubRuntime } from "./runtime.js";

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
        physicalCriticalBytes: 4_750_000,
        physicalTotalBytes: 5_000_000,
        minimumFreeBytes: 10,
        batchSize: 1,
        incrementalVacuumPages: 1,
      },
      readPhysicalUsage: () => ({ ...safeUsage(), totalBytes: 4_499_999 }),
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
});

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

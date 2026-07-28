import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { NormalizedEvent } from "@intexura-error-hub/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPrivateApp } from "../private-app.js";
import { createOperationsContext } from "../operations.js";
import { openDatabase, type ErrorHubDatabase } from "../storage/database.js";
import { IssueRepository } from "../storage/issue-repository.js";
import { migrateDatabase } from "../storage/migrate.js";
import { ProjectRepository } from "../storage/project-repository.js";

const ORGANIZATION = "intexuraos";
const PROJECT_SLUG = "intexuraos-backend";
const PRIVATE_ORIGIN = "https://hub.test:8443";
const EVENT_ONE = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const EVENT_TWO = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

describe("Sentry worker evidence API", () => {
  let database: ErrorHubDatabase;
  let issueId: number;
  let app: ReturnType<typeof createPrivateApp>;

  beforeEach(() => {
    database = openDatabase(":memory:");
    migrateDatabase(database, "2026-07-28T00:00:00.000Z");
    issueId = seedEvidence(database);
    app = createPrivateApp({
      database,
      operations: createOperationsContext(),
      privateOrigin: new URL(PRIVATE_ORIGIN),
      organizationSlug: ORGANIZATION,
      allowedHosts: ["hub.test:8443"],
      allowedOrigins: [PRIVATE_ORIGIN],
      publicIngestHosts: ["errors.test"],
    });
  });

  afterEach(async () => {
    await app.close();
    database.close();
  });

  it("implements exactly the five successful trailing-slash GET routes", async () => {
    const shortId = `INTEXURA-HUB-${String(issueId)}`;
    const issue = await sentryGet(
      `/api/0/organizations/${ORGANIZATION}/issues/${shortId}/`,
    );
    expect(issue.statusCode).toBe(200);
    expect(issue.headers["content-type"]).toContain("application/json");
    expect(issue.json()).toEqual({
      id: String(issueId),
      shortId,
      title: "TypeError: worker failed",
      firstSeen: "2026-07-28T09:00:00.000Z",
      lastSeen: "2026-07-28T10:00:00.000Z",
      count: "2",
      userCount: 0,
      permalink: `${PRIVATE_ORIGIN}/organizations/${ORGANIZATION}/issues/${String(issueId)}/`,
      project: { id: "1", slug: PROJECT_SLUG, name: "IntexuraOS Backend" },
      platform: "node",
      status: "unresolved",
      culprit: "run",
      type: "error",
      issueCategory: "error",
    });

    const latest = await sentryGet(
      `/api/0/organizations/${ORGANIZATION}/issues/${String(issueId)}/events/latest/`,
    );
    expect(latest.statusCode).toBe(200);
    expect(latest.json()).toEqual(
      expect.objectContaining({
        id: EVENT_TWO,
        title: "TypeError: worker failed",
        message: "worker failed 2",
        type: "error",
        culprit: "run",
        dateCreated: "2026-07-28T10:00:00.000Z",
        occurrenceCount: 2,
        permalink: `${PRIVATE_ORIGIN}/organizations/${ORGANIZATION}/issues/${String(issueId)}/events/${EVENT_TWO}/`,
        entries: expect.arrayContaining([
          {
            type: "exception",
            data: {
              values: [
                expect.objectContaining({
                  type: "TypeError",
                  value: "worker failed",
                  stacktrace: {
                    frames: [
                      expect.objectContaining({
                        filename: "src/worker.ts",
                        function: "run",
                        lineNo: 42,
                        colNo: 7,
                        absPath: "/srv/src/worker.ts",
                        inApp: true,
                      }),
                    ],
                  },
                }),
              ],
            },
          },
          expect.objectContaining({ type: "breadcrumbs" }),
        ]),
        contexts: {
          runtime: { type: "runtime", name: "node", version: "22.23.1" },
        },
        tags: expect.arrayContaining([
          { key: "environment", value: "prod" },
          { key: "release", value: "release-2" },
          { key: "service", value: "code-agent" },
          { key: "component", value: "worker" },
        ]),
      }),
    );

    const explicit = await sentryGet(
      `/api/0/organizations/${ORGANIZATION}/issues/${shortId}/events/${EVENT_ONE}/`,
    );
    expect(explicit.statusCode).toBe(200);
    expect(explicit.json()).toEqual(expect.objectContaining({ id: EVENT_ONE }));

    const list = await sentryGet(
      `/api/0/organizations/${ORGANIZATION}/issues/${shortId}/events/?query=environment%3Aprod&per_page=1&sort=-timestamp&statsPeriod=14d`,
    );
    expect(list.statusCode).toBe(200);
    expect(Array.isArray(list.json())).toBe(true);
    expect(list.json()).toEqual([
      expect.objectContaining({
        id: EVENT_TWO,
        issue: shortId,
        project: PROJECT_SLUG,
        timestamp: "2026-07-28T10:00:00.000Z",
        environment: "prod",
        release: "release-2",
        "count()": 2,
      }),
    ]);

    for (const projectLocator of [PROJECT_SLUG, "1"]) {
      const project = await sentryGet(
        `/api/0/projects/${ORGANIZATION}/${projectLocator}/`,
      );
      expect(project.statusCode).toBe(200);
      expect(project.json()).toEqual({
        id: "1",
        slug: PROJECT_SLUG,
        name: "IntexuraOS Backend",
        platform: "node",
      });
    }
  });

  it("returns structured fast 404s for wrong membership and every unsupported /api/0 request", async () => {
    const wrongOrganization = await sentryGet(
      `/api/0/organizations/wrong/issues/${String(issueId)}/`,
    );
    expect(wrongOrganization.statusCode).toBe(404);
    expect(wrongOrganization.json()).toEqual({
      detail: "Unsupported endpoint",
    });

    const wrongIssueEvent = await sentryGet(
      `/api/0/organizations/${ORGANIZATION}/issues/999/events/${EVENT_ONE}/`,
    );
    expect(wrongIssueEvent.statusCode).toBe(404);
    expect(wrongIssueEvent.json()).toEqual({ detail: "Unsupported endpoint" });

    for (const request of [
      {
        method: "GET" as const,
        url: "/api/0/organizations/intexuraos/issues/1/autofix/",
      },
      {
        method: "HEAD" as const,
        url: `/api/0/organizations/${ORGANIZATION}/issues/${String(issueId)}/`,
      },
      {
        method: "POST" as const,
        url: `/api/0/organizations/${ORGANIZATION}/issues/${String(issueId)}/`,
      },
      {
        method: "GET" as const,
        url: `/api/0/projects/${ORGANIZATION}/${PROJECT_SLUG}`,
      },
    ]) {
      const response = await app.inject({
        ...request,
        headers: { host: "hub.test:8443" },
      });
      expect(response.statusCode).toBe(404);
      expect(response.headers["content-type"]).toContain("application/json");
      if (request.method !== "HEAD") {
        expect(response.json()).toEqual({ detail: "Unsupported endpoint" });
      }
    }
  });

  it("bounds statsPeriod before arithmetic and always returns structured validation errors", async () => {
    const base = `/api/0/organizations/${ORGANIZATION}/issues/${String(issueId)}/events/`;
    expect((await sentryGet(`${base}?statsPeriod=90d`)).statusCode).toBe(200);
    for (const period of [
      "91d",
      "2161h",
      "9000000000d",
      "9007199254740991w",
      `${"9".repeat(128)}w`,
    ]) {
      const response = await sentryGet(
        `${base}?statsPeriod=${encodeURIComponent(period)}`,
      );
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        error: {
          code: "invalid_request",
          message: "Sentry event query is invalid",
        },
      });
    }
  });

  async function sentryGet(url: string) {
    return app.inject({
      method: "GET",
      url,
      headers: {
        host: "hub.test:8443",
        authorization: "Bearer syntactic-token",
      },
    });
  }
});

describe("pinned official Sentry MCP compatibility", () => {
  it("fails closed and records an outbound attempt outside the selected loopback endpoint", async () => {
    const directory = mkdtempSync(join(tmpdir(), "error-hub-network-guard-"));
    const reportPath = join(directory, "denied.ndjson");
    writeFileSync(reportPath, "", "utf8");
    try {
      const child = spawn(
        process.execPath,
        [
          "--import",
          networkGuardFixture(),
          "--eval",
          'await fetch("http://127.0.0.1:9/denied")',
        ],
        {
          env: minimalChildEnvironment("127.0.0.1:8", reportPath),
          stdio: "ignore",
        },
      );
      const exitCode = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
      expect(exitCode).not.toBe(0);
      expect(readNetworkReport(reportPath)).toEqual([
        { kind: "fetch", target: "http://127.0.0.1:9/denied" },
      ]);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("terminates the spawned MCP child when client initialization fails", async () => {
    const directory = mkdtempSync(join(tmpdir(), "error-hub-mcp-failure-"));
    const reportPath = join(directory, "denied.ndjson");
    writeFileSync(reportPath, "", "utf8");
    const transport = new PidCapturingStdioClientTransport({
      command: process.execPath,
      args: [
        "--import",
        networkGuardFixture(),
        sentryMcpBinary(),
        "--host=127.0.0.1:8",
        "--insecure-http",
        "--access-token=syntactic-token",
        "--skills=inspect",
        "--disable-skills=seer",
      ],
      env: minimalChildEnvironment("127.0.0.1:8", reportPath),
      stderr: "pipe",
    });
    const childClosed = transportClosePromise(transport);
    const client = new Client({
      name: "error-hub-failed-initialization",
      version: "1.0.0",
    });
    let processExited = false;
    let closeObserved = false;
    try {
      await expect(
        client.connect(transport, {
          signal: AbortSignal.abort(new Error("forced initialization failure")),
        }),
      ).rejects.toThrow("forced initialization failure");
      expect(transport.spawnedPid).toBeTypeOf("number");
    } finally {
      await client.close().catch(() => undefined);
      await transport.close().catch(() => undefined);
      closeObserved = await promiseSettledWithin(childClosed, 2_000);
      processExited = await capturedProcessExited(transport.spawnedPid);
      if (!processExited && transport.spawnedPid !== null) {
        terminateProcess(transport.spawnedPid);
        await waitForProcessExit(transport.spawnedPid);
      }
      const deniedAttempts = readNetworkReport(reportPath);
      rmSync(directory, { force: true, recursive: true });
      expect(closeObserved).toBe(true);
      expect(processExited).toBe(true);
      expect(transport.pid).toBeNull();
      expect(deniedAttempts).toEqual([]);
    }
  }, 30_000);

  it("runs get_issue_details and search_issue_events through execute_sentry_tool without external services", async () => {
    const restoreEnvironment = poisonAmbientMcpEnvironment();
    const directory = mkdtempSync(join(tmpdir(), "error-hub-mcp-probe-"));
    const reportPath = join(directory, "denied.ndjson");
    writeFileSync(reportPath, "", "utf8");
    const calls: Array<{
      method: string;
      url: string;
      authorization: string | undefined;
    }> = [];
    let database: ErrorHubDatabase | null = null;
    let app: ReturnType<typeof createPrivateApp> | null = null;
    let client: Client | null = null;
    let transport: PidCapturingStdioClientTransport | null = null;
    let childClosed: Promise<void> | null = null;
    let childPid: number | null = null;
    try {
      const port = await reservePort();
      const host = `127.0.0.1:${String(port)}`;
      const activeDatabase = openDatabase(":memory:");
      database = activeDatabase;
      migrateDatabase(activeDatabase, "2026-07-28T00:00:00.000Z");
      const issueId = seedEvidence(activeDatabase);
      const activeApp = createPrivateApp({
        database: activeDatabase,
        operations: createOperationsContext(),
        privateOrigin: new URL(PRIVATE_ORIGIN),
        organizationSlug: ORGANIZATION,
        allowedHosts: [host],
        allowedOrigins: [PRIVATE_ORIGIN],
        publicIngestHosts: ["errors.test"],
      });
      app = activeApp;
      activeApp.addHook("onRequest", async (request) => {
        calls.push({
          method: request.method,
          url: request.raw.url ?? "",
          authorization: request.headers.authorization,
        });
      });
      await activeApp.listen({ host: "127.0.0.1", port });
      transport = new PidCapturingStdioClientTransport({
        command: process.execPath,
        args: [
          "--import",
          networkGuardFixture(),
          sentryMcpBinary(),
          `--host=${host}`,
          "--insecure-http",
          "--access-token=syntactic-token",
          "--skills=inspect",
          "--disable-skills=seer",
        ],
        env: minimalChildEnvironment(host, reportPath),
        stderr: "pipe",
      });
      childClosed = transportClosePromise(transport);
      client = new Client({
        name: "error-hub-compatibility",
        version: "1.0.0",
      });
      await client.connect(transport);
      childPid = transport.spawnedPid;
      expect(childPid).toBeTypeOf("number");
      const tools = await client.listTools();
      const names = tools.tools.map((tool) => tool.name);
      expect(names).toContain("execute_sentry_tool");
      expect(names).not.toContain("get_issue_details");
      expect(names).not.toContain("search_issue_events");

      const details = await client.callTool({
        name: "execute_sentry_tool",
        arguments: {
          name: "get_issue_details",
          arguments: {
            organizationSlug: ORGANIZATION,
            issueId: String(issueId),
          },
        },
      });
      const detailText = toolText(details);
      expect(detailText).toContain("TypeError: worker failed");
      expect(detailText).toContain("src/worker.ts");
      expect(detailText).toContain("release-2");
      expect(detailText).toContain("environment");
      expect(detailText).toContain("Occurrences**: 2");

      const search = await client.callTool({
        name: "execute_sentry_tool",
        arguments: {
          name: "search_issue_events",
          arguments: {
            organizationSlug: ORGANIZATION,
            issueId: String(issueId),
            projectSlug: PROJECT_SLUG,
            query: "environment:prod",
            sort: "-timestamp",
            period: "14d",
            limit: 2,
          },
        },
      });
      const searchText = toolText(search);
      expect(searchText).toContain("Found 2 errors");
      expect(searchText).toContain(EVENT_TWO);
      expect(searchText).toContain("release-2");

      const urls = calls.map((call) => call.url);
      const shortId = `INTEXURA-HUB-${String(issueId)}`;
      expect(urls).toContain(
        `/api/0/organizations/${ORGANIZATION}/issues/${String(issueId)}/`,
      );
      expect(urls).toContain(
        `/api/0/organizations/${ORGANIZATION}/issues/${shortId}/events/latest/`,
      );
      expect(urls).toContain(
        `/api/0/organizations/${ORGANIZATION}/issues/${shortId}/autofix/`,
      );
      expect(urls).toContain(
        `/api/0/organizations/${ORGANIZATION}/issues/${shortId}/external-issues/`,
      );
      expect(
        urls.some((url) =>
          url.startsWith(`/api/0/organizations/${ORGANIZATION}/replay-count/?`),
        ),
      ).toBe(true);
      expect(urls).toContain(
        `/api/0/projects/${ORGANIZATION}/${PROJECT_SLUG}/`,
      );
      expect(
        urls.some(
          (url) =>
            url.startsWith(
              `/api/0/organizations/${ORGANIZATION}/issues/${String(issueId)}/events/?`,
            ) &&
            url.includes("query=environment%3Aprod") &&
            url.includes("per_page=2") &&
            url.includes("sort=-timestamp") &&
            url.includes("statsPeriod=14d"),
        ),
      ).toBe(true);
      expect(calls.every((call) => call.method === "GET")).toBe(true);
      expect(
        calls.every((call) => call.authorization === "Bearer syntactic-token"),
      ).toBe(true);
    } finally {
      await client?.close().catch(() => undefined);
      await transport?.close().catch(() => undefined);
      childPid ??= transport?.spawnedPid ?? null;
      const closeObserved =
        childClosed === null
          ? false
          : await promiseSettledWithin(childClosed, 2_000);
      const processExited = await capturedProcessExited(childPid);
      if (!processExited && childPid !== null) {
        terminateProcess(childPid);
        await waitForProcessExit(childPid);
      }
      const transportPid = transport?.pid ?? null;
      const deniedAttempts = readNetworkReport(reportPath);
      try {
        await app?.close();
      } finally {
        try {
          database?.close();
        } finally {
          restoreEnvironment();
          rmSync(directory, { force: true, recursive: true });
        }
      }
      expect(childPid).toBeTypeOf("number");
      expect(closeObserved).toBe(true);
      expect(processExited).toBe(true);
      expect(transportPid).toBeNull();
      expect(deniedAttempts).toEqual([]);
    }
  }, 30_000);
});

class PidCapturingStdioClientTransport extends StdioClientTransport {
  public spawnedPid: number | null = null;

  public override async start(): Promise<void> {
    await super.start();
    const pid = this.pid;
    if (pid === null) throw new Error("MCP child PID unavailable after spawn");
    this.spawnedPid = pid;
  }
}

function seedEvidence(database: ErrorHubDatabase): number {
  const projects = new ProjectRepository(database);
  projects.create({
    id: 1,
    slug: PROJECT_SLUG,
    name: "IntexuraOS Backend",
    enabled: true,
    createdAt: "2026-07-28T00:00:00.000Z",
  });
  projects.setIngestKey({
    projectId: 1,
    environment: "prod",
    publicKey: "prod-key",
    allowedOrigins: [],
    forwardingMode: "disabled",
    forwardingSecretRef: null,
    webhookMode: "disabled",
    webhookTargetUrl: null,
    webhookSecretRef: null,
    enabledAt: null,
  });
  const issues = new IssueRepository(database);
  const first = issues.recordOccurrence(
    evidenceOccurrence(EVENT_ONE, "2026-07-28T09:00:00.000Z", "release-1", 1),
  );
  issues.recordOccurrence(
    evidenceOccurrence(EVENT_TWO, "2026-07-28T10:00:00.000Z", "release-2", 2),
  );
  return first.issueId;
}

function evidenceOccurrence(
  id: string,
  occurredAt: string,
  release: string,
  sequence: number,
) {
  return {
    projectId: 1,
    event: evidenceEvent(id, occurredAt, release, sequence),
    fingerprint: {
      version: 1 as const,
      digest: "d".repeat(64),
      explanation: ["test"],
    },
    buildOutbox: () => ({
      deliveryId: "44444444-4444-4444-8444-444444444444",
      mode: "disabled" as const,
      targetUrl: null,
      secretRef: null,
      signature: null,
      body: Buffer.from('{"action":"triggered"}', "utf8"),
    }),
  };
}

function evidenceEvent(
  id: string,
  occurredAt: string,
  release: string,
  sequence: number,
): NormalizedEvent {
  return {
    id,
    occurredAt,
    receivedAt: new Date(Date.parse(occurredAt) + 1_000).toISOString(),
    level: "error",
    title: "TypeError: worker failed",
    message: `worker failed ${String(sequence)}`,
    exception: {
      type: "TypeError",
      value: "worker failed",
      mechanism: { type: "generic", handled: false },
      frames: [
        {
          filename: "src/worker.ts",
          function: "run",
          module: "worker",
          lineno: 42,
          colno: 7,
          abs_path: "/srv/src/worker.ts",
          in_app: true,
        },
      ],
      discardedValues: 0,
    },
    breadcrumbs: [
      {
        timestamp: occurredAt,
        type: "default",
        category: "worker",
        level: "info",
        message: "job started",
      },
    ],
    tags: { component: "worker" },
    release,
    environment: "prod",
    serverName: "code-agent",
    platform: "node",
    logger: "worker",
    requestId: `request-${String(sequence)}`,
    traceId: null,
    taskId: `task-${String(sequence)}`,
    payload: {
      contexts: { runtime: { name: "node", version: "22.23.1" } },
      extras: { operation: "execute" },
      correlations: {},
    },
    payloadBytes: 100,
    truncated: false,
    truncationReasons: [],
  };
}

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("ephemeral port unavailable");
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  );
  return address.port;
}

function sentryMcpBinary(): string {
  return fileURLToPath(
    new URL(
      "../../node_modules/@sentry/mcp-server/dist/index.js",
      import.meta.url,
    ),
  );
}

function networkGuardFixture(): string {
  return fileURLToPath(new URL("./network-guard.fixture.mjs", import.meta.url));
}

function minimalChildEnvironment(
  allowedEndpoint: string,
  reportPath: string,
): Record<string, string> {
  return {
    ERROR_HUB_NETWORK_ALLOWED_ENDPOINT: allowedEndpoint,
    ERROR_HUB_NETWORK_REPORT_PATH: reportPath,
  };
}

function poisonAmbientMcpEnvironment(): () => void {
  const poison = {
    SENTRY_URL: "http://127.0.0.1:9",
    SENTRY_HOST: "attacker.invalid",
    SENTRY_ACCESS_TOKEN: "ambient-sentry-token",
    DEFAULT_SENTRY_DSN: "https://ambient@sentry.invalid/1",
    MCP_URL: "https://attacker.invalid/mcp",
    MCP_HOST: "attacker.invalid",
    MCP_TOKEN: "ambient-mcp-token",
    AI_GATEWAY_API_KEY: "ambient-ai-gateway-key",
    OPENAI_API_KEY: "ambient-provider-key",
    OTEL_EXPORTER_OTLP_ENDPOINT: "https://attacker.invalid/telemetry",
  } as const;
  const previous = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(poison)) {
    previous.set(name, process.env[name]);
    process.env[name] = value;
  }
  return () => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

function readNetworkReport(
  path: string,
): Array<{ readonly kind: string; readonly target: string }> {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as { kind: string; target: string });
}

async function waitForProcessExit(pid: number): Promise<boolean> {
  const deadline = Date.now() + 2_000;
  while (processRunning(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return !processRunning(pid);
}

async function capturedProcessExited(pid: number | null): Promise<boolean> {
  return pid === null ? false : waitForProcessExit(pid);
}

function transportClosePromise(transport: StdioClientTransport): Promise<void> {
  return new Promise((resolve) => {
    transport.onclose = resolve;
  });
}

async function promiseSettledWithin(
  promise: Promise<void>,
  milliseconds: number,
): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => resolve(false), milliseconds);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function terminateProcess(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if (
      typeof error !== "object" ||
      error === null ||
      (error as { code?: unknown }).code !== "ESRCH"
    ) {
      throw error;
    }
  }
}

function processRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      (error as { code?: unknown }).code === "ESRCH"
    ) {
      return false;
    }
    throw error;
  }
}

function toolText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = (result as { readonly content?: unknown }).content;
  if (!Array.isArray(content))
    throw new Error("MCP tool result has no content array");
  return (content as unknown[])
    .filter(
      (entry): entry is { type: "text"; text: string } =>
        typeof entry === "object" &&
        entry !== null &&
        (entry as { type?: unknown }).type === "text" &&
        typeof (entry as { text?: unknown }).text === "string",
    )
    .map((entry) => entry.text)
    .join("\n");
}

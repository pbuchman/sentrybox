import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import type { SecretStore } from "./secrets.js";
import { createShadowForwarder } from "./ingest/shadow-forwarder.js";
import { createOperationsContext } from "./operations.js";
import { createPrivateApp } from "./private-app.js";
import { createPublicApp, type PublicIngestLimits } from "./public-app.js";
import { createPhysicalStorageSampler } from "./retention/physical-storage.js";
import type {
  PhysicalStorageUsage,
  RetentionConfig,
} from "./retention/storage-budget.js";
import { RetentionSweeper } from "./retention/sweeper.js";
import { PhysicalSafetyMonitor } from "./retention/physical-monitor.js";
import { openDatabase, type ErrorHubDatabase } from "./storage/database.js";
import { migrateDatabase } from "./storage/migrate.js";
import { OutboxRepository } from "./storage/outbox-repository.js";
import { registerStaticUi } from "./static-ui.js";
import {
  FetchWebhookHttpClient,
  WebhookDispatcher,
  type WebhookHttpClient,
} from "./webhooks/dispatcher.js";
import { buildCodeAgentOutboxDraft } from "./webhooks/payload.js";

export interface ListenerOptions {
  readonly host?: string;
  readonly port: number;
}

export interface RuntimeCadence {
  readonly retentionMs: number;
  readonly dispatchMs: number;
  readonly physicalMonitorMs: number;
}

export interface RuntimeShadowOptions {
  readonly queueCapacity: number;
  readonly concurrency: number;
  readonly requestTimeoutMs: number;
}

export interface StartRuntimeOptions {
  readonly databasePath: string;
  readonly dataDirectory: string;
  readonly staticRoot: string;
  readonly publicListener?: ListenerOptions;
  readonly privateListener?: ListenerOptions;
  readonly privateOrigin: URL;
  readonly organizationSlug: string;
  readonly allowedHosts: readonly string[];
  readonly allowedOrigins: readonly string[];
  readonly publicIngestHosts: readonly string[];
  readonly secrets: Pick<SecretStore, "references" | "resolve">;
  readonly retentionConfig?: RetentionConfig;
  readonly publicLimits?: Partial<PublicIngestLimits>;
  readonly cadence?: Partial<RuntimeCadence>;
  readonly shadow?: Partial<RuntimeShadowOptions>;
  readonly shutdownTimeoutMs?: number;
  readonly readPhysicalUsage?: (
    signal?: AbortSignal,
  ) => PhysicalStorageUsage | Promise<PhysicalStorageUsage>;
  readonly webhookHttp?: WebhookHttpClient;
}

export interface ErrorHubRuntime {
  readonly publicUrl: URL;
  readonly privateUrl: URL;
  close(): Promise<void>;
}

const DEFAULT_CADENCE: RuntimeCadence = {
  retentionMs: 60 * 60_000,
  dispatchMs: 1_000,
  physicalMonitorMs: 5_000,
};

const DEFAULT_SHADOW: RuntimeShadowOptions = {
  queueCapacity: 100,
  concurrency: 2,
  requestTimeoutMs: 5_000,
};

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;

export async function startRuntime(
  options: StartRuntimeOptions,
): Promise<ErrorHubRuntime> {
  const publicListener = normalizedListener(options.publicListener, 8_140);
  const privateListener = normalizedListener(options.privateListener, 8_141);
  await assertDistinctListeners(publicListener, privateListener);
  const cadence = validatedCadence(options.cadence);
  const shadow = validatedPositiveOptions(DEFAULT_SHADOW, options.shadow);
  const shutdownTimeoutMs = positiveSafeInteger(
    options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
    "shutdown timeout",
  );
  const database = openDatabase(options.databasePath);
  let publicApp: FastifyInstance | null = null;
  let privateApp: FastifyInstance | null = null;
  const abortController = new AbortController();
  const loops: RuntimeLoop[] = [];
  try {
    migrateDatabase(database);
    const operations = createOperationsContext(options.retentionConfig);
    const defaultPhysicalUsage = createPhysicalStorageSampler({
      dataDirectory: options.dataDirectory,
      databasePath: options.databasePath,
      maxDirectoryEntries: 1_000,
    });
    const configuredPhysicalUsage =
      options.readPhysicalUsage ??
      ((signal?: AbortSignal) => {
        if (signal?.aborted === true) throw signal.reason;
        return defaultPhysicalUsage();
      });
    const readPhysicalUsage = (signal?: AbortSignal) =>
      configuredPhysicalUsage(signal);
    const sweeper = new RetentionSweeper({
      database,
      operations,
      readPhysicalUsage,
      yieldControl: () => abortableYield(abortController.signal),
    });
    const physicalMonitor = new PhysicalSafetyMonitor({
      database,
      operations,
      readPhysicalUsage,
    });
    const initialRetention = await sweeper.run();
    if (!initialRetention.success) {
      throw new Error(`initial retention failed: ${initialRetention.failure}`);
    }
    const shadowForwarder = createShadowForwarder({
      secretResolver: options.secrets,
      ...shadow,
    });
    const outbox = new OutboxRepository(database);
    const dispatcher = new WebhookDispatcher({
      outbox,
      operations,
      http: options.webhookHttp ?? new FetchWebhookHttpClient(),
    });
    publicApp = createPublicApp({
      database,
      operations,
      shadowForwarder,
      buildOutbox: (input) =>
        buildCodeAgentOutboxDraft({
          ...input,
          privateHubOrigin: options.privateOrigin,
          organizationSlug: options.organizationSlug,
          deliveryId: randomUUID(),
          secrets: options.secrets,
        }),
      ...(options.publicLimits === undefined
        ? {}
        : { limits: options.publicLimits }),
    });
    privateApp = createPrivateApp({
      database,
      operations,
      privateOrigin: options.privateOrigin,
      organizationSlug: options.organizationSlug,
      allowedHosts: options.allowedHosts,
      allowedOrigins: options.allowedOrigins,
      publicIngestHosts: options.publicIngestHosts,
      secrets: options.secrets,
    });
    registerStaticUi(privateApp, { root: options.staticRoot });
    await privateApp.listen(privateListener);
    await publicApp.listen(publicListener);
    const publicUrl = listenerUrl(publicApp, publicListener.host);
    const privateUrl = listenerUrl(privateApp, privateListener.host);
    if (publicUrl.origin === privateUrl.origin) {
      throw new Error("public and private listeners resolved to one endpoint");
    }
    loops.push(
      startLoop(
        () => sweeper.run(),
        cadence.retentionMs,
        abortController.signal,
      ),
      startLoop(
        () => dispatcher.dispatchDue(),
        cadence.dispatchMs,
        abortController.signal,
      ),
      startLoop(
        () => physicalMonitor.sample(abortController.signal),
        cadence.physicalMonitorMs,
        abortController.signal,
      ),
    );

    const close = createIdempotentClose(() =>
      closeRuntime(
        {
          publicApp: requireApp(publicApp),
          privateApp: requireApp(privateApp),
          database,
          dispatcher,
          shadowForwarder,
          loops,
          abortController,
        },
        shutdownTimeoutMs,
      ),
    );
    return {
      publicUrl,
      privateUrl,
      close,
    };
  } catch (error) {
    abortController.abort();
    await Promise.allSettled(loops.map(async (loop) => loop.close()));
    await closeApp(publicApp);
    await closeApp(privateApp);
    closeDatabase(database);
    throw error;
  }
}

interface CloseRuntimeOptions {
  readonly publicApp: FastifyInstance;
  readonly privateApp: FastifyInstance;
  readonly database: ErrorHubDatabase;
  readonly dispatcher: WebhookDispatcher;
  readonly shadowForwarder: ReturnType<typeof createShadowForwarder>;
  readonly loops: readonly RuntimeLoop[];
  readonly abortController: AbortController;
}

async function closeRuntime(
  options: CloseRuntimeOptions,
  timeoutMs: number,
): Promise<void> {
  await runBoundedShutdown(
    {
      stopPublicIngress: async () => options.publicApp.close(),
      forceStopPublicIngress: () =>
        options.publicApp.server.closeAllConnections(),
      abortLoops: () => options.abortController.abort(new Error("shutdown")),
      drainShadow: async () => options.shadowForwarder.drain(),
      drainOutbox: async () => drainOutbox(options.dispatcher),
      closeLoops: async () =>
        Promise.all(options.loops.map(async (loop) => loop.close())).then(
          () => undefined,
        ),
      checkpointWal: () => options.database.pragma("wal_checkpoint(PASSIVE)"),
      closePrivateListener: async () => options.privateApp.close(),
      forceStopPrivateListener: () =>
        options.privateApp.server.closeAllConnections(),
      closeDatabase: () => closeDatabase(options.database),
    },
    timeoutMs,
  );
}

export interface RuntimeShutdownActions {
  readonly stopPublicIngress: () => Promise<void>;
  readonly forceStopPublicIngress: () => void;
  readonly abortLoops: () => void;
  readonly drainShadow: () => Promise<void>;
  readonly drainOutbox: () => Promise<void>;
  readonly closeLoops: () => Promise<void>;
  readonly checkpointWal: () => void;
  readonly closePrivateListener: () => Promise<void>;
  readonly forceStopPrivateListener: () => void;
  readonly closeDatabase: () => void;
}

export class RuntimeShutdownError extends AggregateError {
  public constructor(errors: readonly Error[]) {
    super(errors, "SentryBox shutdown did not complete cleanly");
    this.name = "RuntimeShutdownError";
  }
}

export async function runBoundedShutdown(
  actions: RuntimeShutdownActions,
  timeoutMs: number,
): Promise<void> {
  const boundedTimeout = positiveSafeInteger(timeoutMs, "shutdown timeout");
  const errors: Error[] = [];
  const asyncStepTimeoutMs = Math.max(1, Math.floor(boundedTimeout / 5));
  const publicStopped = await captureAsyncStep(
    "stop public ingress",
    actions.stopPublicIngress,
    asyncStepTimeoutMs,
    errors,
  );
  if (!publicStopped) {
    captureSyncStep(
      "force stop public ingress",
      actions.forceStopPublicIngress,
      errors,
    );
  }
  captureSyncStep("abort loops", actions.abortLoops, errors);
  await captureAsyncStep(
    "drain shadow forwarding",
    actions.drainShadow,
    asyncStepTimeoutMs,
    errors,
  );
  await captureAsyncStep(
    "drain webhook outbox",
    actions.drainOutbox,
    asyncStepTimeoutMs,
    errors,
  );
  await captureAsyncStep(
    "close runtime loops",
    actions.closeLoops,
    asyncStepTimeoutMs,
    errors,
  );
  captureSyncStep("checkpoint WAL", actions.checkpointWal, errors);
  const privateStopped = await captureAsyncStep(
    "close private listener",
    actions.closePrivateListener,
    asyncStepTimeoutMs,
    errors,
  );
  if (!privateStopped) {
    captureSyncStep(
      "force stop private listener",
      actions.forceStopPrivateListener,
      errors,
    );
  }
  captureSyncStep("close database", actions.closeDatabase, errors);
  if (errors.length > 0) throw new RuntimeShutdownError(errors);
}

export function createIdempotentClose(
  action: () => Promise<void>,
): () => Promise<void> {
  let outcome: Promise<void> | null = null;
  return () => {
    if (outcome !== null) return outcome;
    try {
      outcome = action();
    } catch (error) {
      outcome = Promise.reject(error);
    }
    return outcome;
  };
}

async function captureAsyncStep(
  name: string,
  action: () => Promise<void>,
  timeoutMs: number,
  errors: Error[],
): Promise<boolean> {
  try {
    await promiseWithTimeout(action(), timeoutMs, name);
    return true;
  } catch (error) {
    errors.push(shutdownStepError(name, error));
    return false;
  }
}

function captureSyncStep(
  name: string,
  action: () => void,
  errors: Error[],
): boolean {
  try {
    action();
    return true;
  } catch (error) {
    errors.push(shutdownStepError(name, error));
    return false;
  }
}

async function promiseWithTimeout<T>(
  value: Promise<T>,
  timeoutMs: number,
  name: string,
): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      value,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${name} exceeded its shutdown deadline`)),
          timeoutMs,
        );
        timer.unref();
      }),
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

function shutdownStepError(name: string, error: unknown): Error {
  return new Error(
    `${name}: ${error instanceof Error ? error.message : "unknown failure"}`,
    { cause: error },
  );
}

async function drainOutbox(dispatcher: WebhookDispatcher): Promise<void> {
  for (let batch = 0; batch < 100; batch += 1) {
    const summary = await dispatcher.dispatchDue();
    if (summary.claimed === 0) return;
  }
}

interface RuntimeLoop {
  close(): Promise<void>;
}

function startLoop(
  action: () => Promise<unknown>,
  intervalMs: number,
  signal: AbortSignal,
): RuntimeLoop {
  let timer: NodeJS.Timeout | null = null;
  let running: Promise<void> | null = null;
  const schedule = (): void => {
    if (signal.aborted) return;
    timer = setTimeout(() => {
      timer = null;
      running = action()
        .then(() => undefined)
        .catch(() => undefined)
        .finally(() => {
          running = null;
          schedule();
        });
    }, intervalMs);
    timer.unref();
  };
  schedule();
  return {
    async close() {
      if (timer !== null) clearTimeout(timer);
      await running;
    },
  };
}

async function assertDistinctListeners(
  publicListener: Required<ListenerOptions>,
  privateListener: Required<ListenerOptions>,
): Promise<void> {
  if (publicListener.port === 0 || privateListener.port === 0) return;
  if (publicListener.port !== privateListener.port) return;
  const [publicAddresses, privateAddresses] = await Promise.all([
    resolvedAddresses(publicListener.host),
    resolvedAddresses(privateListener.host),
  ]);
  if ([...publicAddresses].some((address) => privateAddresses.has(address))) {
    throw new TypeError("public and private listeners must be independent");
  }
}

async function resolvedAddresses(host: string): Promise<Set<string>> {
  const addresses = await lookup(host, { all: true, verbatim: true });
  return new Set(addresses.map((entry) => entry.address));
}

function normalizedListener(
  value: ListenerOptions | undefined,
  defaultPort: number,
): Required<ListenerOptions> {
  const host = value?.host ?? "127.0.0.1";
  const port = value?.port ?? defaultPort;
  if (host.trim().length === 0)
    throw new TypeError("listener host is required");
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new TypeError("listener port must be between 0 and 65535");
  }
  return { host, port };
}

function validatedCadence(
  value: Partial<RuntimeCadence> | undefined,
): RuntimeCadence {
  const cadence = { ...DEFAULT_CADENCE, ...value };
  for (const [field, interval] of Object.entries(cadence)) {
    if (!Number.isSafeInteger(interval) || interval <= 0) {
      throw new TypeError(`${field} must be a positive safe integer`);
    }
  }
  return cadence;
}

function validatedPositiveOptions(
  defaults: RuntimeShadowOptions,
  value: Partial<RuntimeShadowOptions> | undefined,
): RuntimeShadowOptions {
  const resolved = { ...defaults, ...value };
  for (const [field, candidate] of Object.entries(resolved)) {
    if (!Number.isSafeInteger(candidate) || candidate <= 0) {
      throw new TypeError(`${field} must be a positive safe integer`);
    }
  }
  return resolved;
}

function positiveSafeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${field} must be a positive safe integer`);
  }
  return value;
}

function listenerUrl(app: FastifyInstance, configuredHost: string): URL {
  const address = app.server.address();
  if (address === null || typeof address === "string") {
    throw new Error("listener address is unavailable");
  }
  const host = loopbackUrlHost(address, configuredHost);
  return new URL(`http://${host}:${String(address.port)}/`);
}

function loopbackUrlHost(address: AddressInfo, configuredHost: string): string {
  const host = address.address === "::" ? configuredHost : address.address;
  return host.includes(":") ? `[${host}]` : host;
}

function requireApp(app: FastifyInstance | null): FastifyInstance {
  if (app === null) throw new Error("runtime app is unavailable");
  return app;
}

async function closeApp(app: FastifyInstance | null): Promise<void> {
  if (app === null) return;
  await app.close().catch(() => undefined);
}

function closeDatabase(database: ErrorHubDatabase): void {
  if (database.open) database.close();
}

async function abortableYield(signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw signal.reason;
  await new Promise<void>((resolveYield, rejectYield) => {
    const onAbort = (): void => {
      clearImmediate(immediate);
      rejectYield(signal.reason);
    };
    const immediate = setImmediate(() => {
      signal.removeEventListener("abort", onAbort);
      resolveYield();
    });
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

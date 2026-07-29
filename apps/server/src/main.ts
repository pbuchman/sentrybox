import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import { loadPublicServerConfig } from "./config.js";
import { startRuntime } from "./runtime.js";
import { loadSecretStore } from "./secrets.js";

type Environment = Readonly<Record<string, string | undefined>>;

export async function runMain(
  environment: Environment = process.env,
): Promise<void> {
  const publicConfig = loadPublicServerConfig(environment);
  const databasePath = resolve(
    environment.ERROR_HUB_DATABASE_PATH ?? "data/error-hub.sqlite",
  );
  const privateOrigin = new URL(
    required(environment, "ERROR_HUB_PRIVATE_ORIGIN"),
  );
  const requiredReferences = commaSeparated(
    environment.ERROR_HUB_REQUIRED_SECRET_REFERENCES ?? "",
  );
  const secrets = loadSecretStore({ environment, requiredReferences });
  const runtime = await startRuntime({
    databasePath,
    dataDirectory: dirname(databasePath),
    staticRoot: fileURLToPath(new URL("../private-ui/", import.meta.url)),
    publicListener: {
      host: environment.ERROR_HUB_PUBLIC_HOST ?? "127.0.0.1",
      port: port(environment.ERROR_HUB_PUBLIC_PORT, 8_140),
    },
    privateListener: {
      host: environment.ERROR_HUB_PRIVATE_HOST ?? "127.0.0.1",
      port: port(environment.ERROR_HUB_PRIVATE_PORT, 8_141),
    },
    privateOrigin,
    organizationSlug: "intexuraos",
    allowedHosts: [privateOrigin.host],
    allowedOrigins: [privateOrigin.origin],
    publicIngestHosts: commaSeparated(
      environment.ERROR_HUB_PUBLIC_INGEST_HOSTS ?? "errors.intexuraos.cloud",
    ),
    grafanaExploreUrl: readGrafanaExploreUrl(environment),
    secrets,
    publicLimits: {
      globalRateLimit: publicConfig.globalRateLimit,
      sourceRateLimit: publicConfig.sourceRateLimit,
      maxSourceKeys: publicConfig.maxSourceKeys,
      projectRateLimit: publicConfig.projectRateLimit,
      rateWindowMs: publicConfig.rateWindowMs,
      retryAfterSeconds: publicConfig.retryAfterSeconds,
      maxConcurrentParses: publicConfig.maxConcurrentParses,
      requestTimeoutMs: publicConfig.requestTimeoutMs,
    },
    shadow: {
      queueCapacity: publicConfig.shadowQueueCapacity,
      concurrency: publicConfig.shadowConcurrency,
      requestTimeoutMs: publicConfig.requestTimeoutMs,
    },
  });
  await waitForShutdown(runtime.close);
}

export function readGrafanaExploreUrl(environment: Environment): URL | null {
  const value = environment.ERROR_HUB_GRAFANA_EXPLORE_URL?.trim();
  if (value === undefined || value.length === 0) return null;
  const shape =
    /^https:\/\/[A-Za-z0-9.-]+(?::([0-9]{1,5}))?\/explore\?orgId=[0-9]+&datasource=[A-Za-z0-9_-]{1,128}$/u.exec(
      value,
    );
  const explicitPort = shape?.[1];
  if (
    shape === null ||
    (explicitPort !== undefined && Number(explicitPort) > 65_535)
  ) {
    throw new Error(
      "Grafana Explore URL must be credential-free HTTPS /explore with exactly one numeric orgId and one valid datasource parameter",
    );
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(
      "Grafana Explore URL must be a valid credential-free HTTPS URL",
    );
  }
  if (
    url.protocol !== "https:" ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.pathname !== "/explore" ||
    url.hash.length > 0 ||
    url.searchParams.getAll("orgId").length !== 1 ||
    !/^\d+$/u.test(url.searchParams.get("orgId") ?? "") ||
    url.searchParams.getAll("datasource").length !== 1 ||
    !/^[A-Za-z0-9_-]{1,128}$/u.test(url.searchParams.get("datasource") ?? "")
  ) {
    throw new Error(
      "Grafana Explore URL must be credential-free HTTPS /explore with exactly one numeric orgId and one valid datasource parameter",
    );
  }
  return url;
}

async function waitForShutdown(close: () => Promise<void>): Promise<void> {
  await new Promise<void>((resolveShutdown, rejectShutdown) => {
    let closing = false;
    const shutdown = (): void => {
      if (closing) return;
      closing = true;
      process.off("SIGINT", shutdown);
      process.off("SIGTERM", shutdown);
      void close().then(resolveShutdown, rejectShutdown);
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}

function required(environment: Environment, name: string): string {
  const value = environment[name]?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} must be configured`);
  }
  return value;
}

function commaSeparated(value: string): string[] {
  return [...new Set(value.split(",").map((entry) => entry.trim()))].filter(
    (entry) => entry.length > 0,
  );
}

function port(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!/^\d{1,5}$/u.test(value)) throw new Error("listener port is invalid");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > 65_535) {
    throw new Error("listener port is invalid");
  }
  return parsed;
}

function isDirectExecution(): boolean {
  const entry = process.argv[1];
  return (
    entry !== undefined &&
    pathToFileURL(resolve(entry)).href === import.meta.url
  );
}

if (isDirectExecution()) {
  void runMain().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "SentryBox startup failed"}\n`,
    );
    process.exitCode = 1;
  });
}

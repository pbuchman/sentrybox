export interface PublicServerConfig {
  readonly envFile: string;
  readonly requestTimeoutMs: number;
  readonly globalRateLimit: number;
  readonly sourceRateLimit: number;
  readonly maxSourceKeys: number;
  readonly projectRateLimit: number;
  readonly rateWindowMs: number;
  readonly retryAfterSeconds: number;
  readonly maxConcurrentParses: number;
  readonly shadowQueueCapacity: number;
  readonly shadowConcurrency: number;
}

type Environment = Readonly<Record<string, string | undefined>>;

const DEFAULTS = {
  requestTimeoutMs: 10_000,
  globalRateLimit: 5_000,
  sourceRateLimit: 120,
  maxSourceKeys: 10_000,
  projectRateLimit: 1_000,
  rateWindowMs: 60_000,
  retryAfterSeconds: 60,
  maxConcurrentParses: 16,
  shadowQueueCapacity: 100,
  shadowConcurrency: 2,
} as const;

export function loadPublicServerConfig(
  environment: Environment = process.env,
): PublicServerConfig {
  const envFile = requiredText(environment, "ERROR_HUB_ENV_FILE");
  return {
    envFile,
    requestTimeoutMs: positiveInteger(
      environment,
      "ERROR_HUB_INGEST_REQUEST_TIMEOUT_MS",
      DEFAULTS.requestTimeoutMs,
    ),
    globalRateLimit: positiveInteger(
      environment,
      "ERROR_HUB_INGEST_GLOBAL_RATE_LIMIT",
      DEFAULTS.globalRateLimit,
    ),
    sourceRateLimit: positiveInteger(
      environment,
      "ERROR_HUB_INGEST_SOURCE_RATE_LIMIT",
      DEFAULTS.sourceRateLimit,
    ),
    maxSourceKeys: positiveInteger(
      environment,
      "ERROR_HUB_INGEST_MAX_SOURCE_KEYS",
      DEFAULTS.maxSourceKeys,
    ),
    projectRateLimit: positiveInteger(
      environment,
      "ERROR_HUB_INGEST_PROJECT_RATE_LIMIT",
      DEFAULTS.projectRateLimit,
    ),
    rateWindowMs: positiveInteger(
      environment,
      "ERROR_HUB_INGEST_RATE_WINDOW_MS",
      DEFAULTS.rateWindowMs,
    ),
    retryAfterSeconds: positiveInteger(
      environment,
      "ERROR_HUB_INGEST_RETRY_AFTER_SECONDS",
      DEFAULTS.retryAfterSeconds,
    ),
    maxConcurrentParses: positiveInteger(
      environment,
      "ERROR_HUB_INGEST_MAX_CONCURRENT_PARSES",
      DEFAULTS.maxConcurrentParses,
    ),
    shadowQueueCapacity: positiveInteger(
      environment,
      "ERROR_HUB_SHADOW_QUEUE_CAPACITY",
      DEFAULTS.shadowQueueCapacity,
    ),
    shadowConcurrency: positiveInteger(
      environment,
      "ERROR_HUB_SHADOW_CONCURRENCY",
      DEFAULTS.shadowConcurrency,
    ),
  };
}

function requiredText(environment: Environment, name: string): string {
  const value = environment[name]?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} must be configured`);
  }
  return value;
}

function positiveInteger(
  environment: Environment,
  name: string,
  fallback: number,
): number {
  const raw = environment[name];
  if (raw === undefined) return fallback;
  if (!/^[1-9]\d*$/u.test(raw)) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}

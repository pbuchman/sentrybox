import { createHash } from "node:crypto";
import process from "node:process";
import { pathToFileURL } from "node:url";

export const CONTROLLED_ENVIRONMENT = "dev";
export const CONTROLLED_PROJECT_ID = 1;
export const CONTROLLED_PROJECT_SLUG = "intexuraos-backend";
export const CONTROLLED_RELEASE = "intexuraos-error-hub-acceptance@1.0.0";

const PUBLIC_INGEST_HOST = "errors.intexuraos.cloud";
const PHASES = new Set(["initial", "duplicate", "regression"]);
const RUN_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{2,63}$/u;

export function deriveControlledIdentity(runId, phase) {
  const canonicalRunId = validateRunId(runId);
  if (!PHASES.has(phase)) throw new TypeError("acceptance phase is invalid");
  const transition = phase === "regression" ? "regression" : "initial";
  const digest = createHash("sha256")
    .update(`intexura-error-hub\0${canonicalRunId}\0${transition}`, "utf8")
    .digest("hex");
  return {
    runId: canonicalRunId,
    phase,
    eventId: digest.slice(0, 32),
    traceId: createHash("sha256")
      .update(`intexura-error-hub\0${canonicalRunId}\0trace`, "utf8")
      .digest("hex")
      .slice(0, 32),
    title: `Controlled Error Hub validation fault [${canonicalRunId}]`,
  };
}

export function validateDevDsn(value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError("ERROR_HUB_DEV_DSN is required");
  }
  let dsn;
  try {
    dsn = new URL(value);
  } catch {
    throw new TypeError("ERROR_HUB_DEV_DSN is not a URL");
  }
  if (
    dsn.protocol !== "https:" ||
    dsn.host !== PUBLIC_INGEST_HOST ||
    dsn.password.length > 0 ||
    !/^[a-f0-9]{32}$/u.test(dsn.username) ||
    dsn.pathname !== `/${String(CONTROLLED_PROJECT_ID)}` ||
    dsn.search.length > 0 ||
    dsn.hash.length > 0
  ) {
    throw new TypeError(
      "ERROR_HUB_DEV_DSN must be the environment-bound backend-dev Hub DSN",
    );
  }
  return dsn;
}

export async function emitControlledIssue(options) {
  const identity = deriveControlledIdentity(options.runId, options.phase);
  const dsn = validateDevDsn(options.dsn);
  const sdk = options.sdk ?? (await import("@sentry/node"));
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new TypeError("fetch implementation is unavailable");
  }
  const deliveryStatuses = [];
  sdk.init({
    dsn: dsn.toString(),
    environment: CONTROLLED_ENVIRONMENT,
    release: CONTROLLED_RELEASE,
    serverName: "error-hub-acceptance",
    sendDefaultPii: false,
    sendClientReports: false,
    autoSessionTracking: false,
    defaultIntegrations: false,
    tracesSampleRate: 0,
    transport: (transportOptions) =>
      sdk.createTransport(transportOptions, async (request) => {
        const response = await fetchImpl(transportOptions.url, {
          method: "POST",
          headers: { "Content-Type": "application/x-sentry-envelope" },
          body:
            typeof request.body === "string"
              ? request.body
              : Buffer.from(request.body),
          redirect: "error",
          signal: AbortSignal.timeout(15_000),
        });
        deliveryStatuses.push(response.status);
        return {
          statusCode: response.status,
          headers: {
            "x-sentry-rate-limits": response.headers.get(
              "x-sentry-rate-limits",
            ),
            "retry-after": response.headers.get("retry-after"),
          },
        };
      }),
  });

  const capturedId = sdk.captureEvent(
    {
      event_id: identity.eventId,
      timestamp: (options.now ?? Date.now)() / 1_000,
      level: "error",
      platform: "node",
      logger: "error-hub-acceptance",
      message: identity.title,
      tags: {
        acceptance: "controlled",
        acceptance_run: identity.runId,
        project: CONTROLLED_PROJECT_SLUG,
        service: "error-hub-acceptance",
      },
      contexts: {
        trace: {
          trace_id: identity.traceId,
          span_id: identity.traceId.slice(0, 16),
          op: "error-hub.acceptance",
        },
      },
      extra: {
        requestId: `error-hub-acceptance-${identity.runId}`,
        acceptancePhase: identity.phase,
      },
      exception: {
        values: [
          {
            type: "ControlledErrorHubValidationFault",
            value: identity.title,
            mechanism: { type: "generic", handled: true },
            stacktrace: {
              frames: [
                {
                  filename: "scripts/acceptance/emit-controlled-issue.mjs",
                  function: "emitControlledIssue",
                  lineno: 1,
                  colno: 1,
                  in_app: true,
                },
              ],
            },
          },
        ],
      },
    },
    { event_id: identity.eventId },
  );

  if (capturedId !== identity.eventId) {
    throw new Error("Sentry SDK did not retain the controlled event identity");
  }
  const flushed = await sdk.flush(15_000);
  if (!flushed) throw new Error("Sentry SDK flush timed out");
  if (deliveryStatuses.length !== 1 || deliveryStatuses[0] !== 200) {
    throw new Error(
      "The supplied ERROR_HUB_DEV_DSN was rejected for dev; production and wrong-environment DSNs are forbidden",
    );
  }
  return {
    phase: identity.phase,
    runId: identity.runId,
    eventId: identity.eventId,
    environment: CONTROLLED_ENVIRONMENT,
    project: CONTROLLED_PROJECT_SLUG,
    release: CONTROLLED_RELEASE,
    accepted: true,
  };
}

export function parseArguments(argv) {
  let phase = null;
  let runId = null;
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (value === undefined) throw new TypeError(`${flag} requires a value`);
    if (flag === "--phase") phase = value;
    else if (flag === "--run-id") runId = value;
    else throw new TypeError(`unknown argument: ${flag}`);
  }
  if (phase === null) throw new TypeError("--phase is required");
  if (runId === null) throw new TypeError("--run-id is required");
  return { phase, runId: validateRunId(runId) };
}

function validateRunId(value) {
  if (typeof value !== "string" || !RUN_ID_PATTERN.test(value)) {
    throw new TypeError(
      "run id must be 3-64 lowercase letters, digits, dots, underscores, or hyphens",
    );
  }
  return value;
}

async function main() {
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "controlled acceptance emission refuses NODE_ENV=production",
    );
  }
  if (
    process.env.ERROR_HUB_ACCEPTANCE_ENVIRONMENT !== undefined &&
    process.env.ERROR_HUB_ACCEPTANCE_ENVIRONMENT !== CONTROLLED_ENVIRONMENT
  ) {
    throw new Error("controlled acceptance emission is dev-only");
  }
  const args = parseArguments(process.argv.slice(2));
  const result = await emitControlledIssue({
    ...args,
    dsn: process.env.ERROR_HUB_DEV_DSN,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "controlled emission failed"}\n`,
    );
    process.exitCode = 1;
  });
}

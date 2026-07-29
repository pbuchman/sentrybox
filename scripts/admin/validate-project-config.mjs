import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { pathToFileURL, URL } from "node:url";

const PROJECT_SLUGS = ["intexuraos-backend", "intexuraos-web"];
const ENVIRONMENTS = ["dev", "prod"];
const SECRET_REFERENCE = /^[A-Z][A-Z0-9_]*$/u;
const CODE_AGENT_TARGETS = {
  dev: "https://dev.intexuraos.cloud/api/code/webhooks/sentry",
  prod: "https://intexuraos.cloud/api/code/webhooks/sentry",
};
const LOCAL_VITE_ORIGIN = "http://localhost:3000";

export function validateProjectConfiguration(value) {
  const input = record(value, "project configuration");
  if (input.version !== 1) {
    throw new TypeError("project configuration version must be 1");
  }
  const publicBaseUrl = canonicalHttpsOrigin(
    input.publicBaseUrl,
    "publicBaseUrl",
  );
  const projects = array(input.projects, "projects");
  if (projects.length !== 2) {
    throw new TypeError("projects must contain exactly two records");
  }

  const projectIds = new Set();
  const projectSlugs = new Set();
  const normalizedProjects = projects.map((candidate, index) => {
    const project = record(candidate, `projects[${String(index)}]`);
    const id = positiveInteger(project.id, "project id");
    const slug = nonEmptyString(project.slug, "project slug");
    const name = nonEmptyString(project.name, "project name");
    if (project.enabled !== true) {
      throw new TypeError("every configured project must be enabled");
    }
    addUnique(projectIds, id, "duplicate project id");
    addUnique(projectSlugs, slug, "duplicate project slug");
    return { id, slug, name, enabled: true };
  });
  requireExactSet(projectSlugs, PROJECT_SLUGS, "project slugs");
  const projectsById = new Map(
    normalizedProjects.map((project) => [project.id, project]),
  );

  const ingestCandidates = array(input.ingestKeys, "ingestKeys");
  if (ingestCandidates.length !== 4) {
    throw new TypeError("ingestKeys must contain exactly four records");
  }
  const keyIds = new Set();
  const projectEnvironments = new Set();
  const normalizedIngestKeys = ingestCandidates.map((candidate, index) => {
    const key = record(candidate, `ingestKeys[${String(index)}]`);
    const id = nonEmptyString(key.id, "ingest key id");
    addUnique(keyIds, id, "duplicate ingest key id");
    const projectId = positiveInteger(key.projectId, "ingest project id");
    const project = projectsById.get(projectId);
    if (project === undefined) {
      throw new TypeError("ingest key references an unknown project");
    }
    const environment = enumValue(
      key.environment,
      ENVIRONMENTS,
      "ingest environment",
    );
    addUnique(
      projectEnvironments,
      `${String(projectId)}\0${environment}`,
      "duplicate project/environment ingest key",
    );
    const expectedId = `${project.slug}-${environment}`;
    if (id !== expectedId) {
      throw new TypeError(
        "ingest key identity does not match its project and environment",
      );
    }
    const allowedOrigins = exactOrigins(key.allowedOrigins, environment);
    const forwarding = validateForwarding(key.forwarding, environment);
    const codeAgent = validateCodeAgent(key.codeAgent, environment);
    return {
      id,
      projectId,
      environment,
      allowedOrigins,
      forwarding,
      codeAgent,
    };
  });

  const expectedPairs = normalizedProjects.flatMap((project) =>
    ENVIRONMENTS.map((environment) => `${String(project.id)}\0${environment}`),
  );
  requireExactSet(
    projectEnvironments,
    expectedPairs,
    "project/environment ingest keys",
  );
  validateEnvironmentSecretSeparation(normalizedIngestKeys);

  return {
    version: 1,
    publicBaseUrl,
    projects: normalizedProjects,
    ingestKeys: normalizedIngestKeys,
  };
}

export function validateDeliveryTransition(value) {
  const input = record(value, "delivery transition");
  const from = enumValue(
    input.from,
    ["disabled", "live"],
    "delivery source mode",
  );
  const to = enumValue(input.to, ["disabled", "live"], "delivery target mode");
  const enabledAt = nullableTimestamp(input.enabledAt, "baseline timestamp");
  if (to === "disabled") {
    if (enabledAt !== null) {
      throw new TypeError("disabled delivery cannot retain a timestamp");
    }
    return { from, to, enabledAt: null };
  }
  if (from === "live") {
    throw new TypeError("Code Agent delivery is already live");
  }
  if (enabledAt === null) {
    throw new TypeError(
      "live delivery requires an explicit baseline timestamp",
    );
  }
  return { from, to, enabledAt };
}

function validateForwarding(value, environment) {
  const input = record(value, "forwarding destination");
  const destinationEnvironment = enumValue(
    input.environment,
    ENVIRONMENTS,
    "forwarding environment",
  );
  if (destinationEnvironment !== environment) {
    throw new TypeError("forwarding environment does not match the ingest key");
  }
  const mode = enumValue(input.mode, ["disabled", "shadow"], "forwarding mode");
  const secretRef = nullableSecretReference(
    input.secretRef,
    "forwarding secret reference",
  );
  if (mode === "disabled" && secretRef !== null) {
    throw new TypeError("disabled forwarding cannot retain a secret reference");
  }
  if (mode === "shadow" && secretRef === null) {
    throw new TypeError("shadow forwarding requires a secret reference");
  }
  if (
    secretRef !== null &&
    !secretRef.endsWith(`_${environment.toUpperCase()}`)
  ) {
    throw new TypeError(
      "forwarding secret reference does not match its environment",
    );
  }
  return { mode, environment, secretRef };
}

function validateCodeAgent(value, environment) {
  const input = record(value, "Code Agent destination");
  const destinationEnvironment = enumValue(
    input.environment,
    ENVIRONMENTS,
    "Code Agent environment",
  );
  if (destinationEnvironment !== environment) {
    throw new TypeError("Code Agent environment does not match the ingest key");
  }
  if (input.mode !== "disabled") {
    throw new TypeError("initial Code Agent delivery mode must be disabled");
  }
  if (input.enabledAt !== null) {
    throw new TypeError("disabled Code Agent delivery cannot have a baseline");
  }
  const targetUrl = canonicalCodeAgentTarget(
    input.targetUrl,
    destinationEnvironment,
  );
  const secretRef = secretReference(
    input.secretRef,
    "Code Agent secret reference",
  );
  if (!secretRef.endsWith(`_${environment.toUpperCase()}`)) {
    throw new TypeError(
      "Code Agent secret reference does not match its environment",
    );
  }
  return {
    mode: "disabled",
    environment,
    targetUrl,
    secretRef,
    enabledAt: null,
  };
}

function validateEnvironmentSecretSeparation(ingestKeys) {
  const references = new Map();
  for (const key of ingestKeys) {
    const current = references.get(key.environment);
    if (current !== undefined && current !== key.codeAgent.secretRef) {
      throw new TypeError(
        "Code Agent keys in one environment must share one HMAC reference",
      );
    }
    references.set(key.environment, key.codeAgent.secretRef);
  }
  if (references.get("dev") === references.get("prod")) {
    throw new TypeError(
      "development and production require separate Code Agent HMAC references",
    );
  }
}

function canonicalCodeAgentTarget(value, environment) {
  const target = canonicalHttpsUrl(value, "Code Agent target URL");
  if (target !== CODE_AGENT_TARGETS[environment]) {
    throw new TypeError("Code Agent target URL does not match its environment");
  }
  return target;
}

function exactOrigins(value, environment) {
  const origins = array(value, "allowedOrigins");
  if (origins.length === 0) {
    throw new TypeError("allowedOrigins must contain at least one origin");
  }
  const normalized = origins.map((origin) =>
    canonicalAllowedOrigin(origin, environment),
  );
  const unique = new Set(normalized);
  if (unique.size !== normalized.length) {
    throw new TypeError("allowedOrigins contains a duplicate origin");
  }
  return [...unique].sort(compareCodePoints);
}

function canonicalAllowedOrigin(value, environment) {
  if (value === LOCAL_VITE_ORIGIN) {
    if (environment !== "dev") {
      throw new TypeError(
        "the local Vite origin is allowed only for development keys",
      );
    }
    return LOCAL_VITE_ORIGIN;
  }
  return canonicalHttpsOrigin(value, "allowedOrigins entry");
}

function canonicalHttpsOrigin(value, field) {
  const url = new URL(nonEmptyString(value, field));
  if (
    url.protocol !== "https:" ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.pathname !== "/" ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new TypeError(`${field} must be an exact HTTPS origin`);
  }
  return url.origin;
}

function canonicalHttpsUrl(value, field) {
  const text = nonEmptyString(value, field);
  const url = new URL(text);
  if (
    url.protocol !== "https:" ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0 ||
    url.toString() !== text
  ) {
    throw new TypeError(`${field} must be a canonical HTTPS URL`);
  }
  return text;
}

function nullableSecretReference(value, field) {
  return value === null ? null : secretReference(value, field);
}

function secretReference(value, field) {
  const reference = nonEmptyString(value, field);
  if (!SECRET_REFERENCE.test(reference)) {
    throw new TypeError(`${field} is invalid`);
  }
  return reference;
}

function nullableTimestamp(value, field) {
  if (value === null) return null;
  const timestamp = nonEmptyString(value, field);
  if (!Number.isFinite(Date.parse(timestamp))) {
    throw new TypeError(`${field} must be an ISO timestamp`);
  }
  return new Date(timestamp).toISOString();
}

function record(value, field) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value;
}

function array(value, field) {
  if (!Array.isArray(value)) {
    throw new TypeError(`${field} must be an array`);
  }
  return value;
}

function positiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${field} must be a positive safe integer`);
  }
  return value;
}

function nonEmptyString(value, field) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value;
}

function enumValue(value, allowed, field) {
  if (!allowed.includes(value)) {
    throw new TypeError(`${field} is invalid`);
  }
  return value;
}

function addUnique(values, value, message) {
  if (values.has(value)) throw new TypeError(message);
  values.add(value);
}

function requireExactSet(actual, expected, field) {
  if (
    actual.size !== expected.length ||
    expected.some((value) => !actual.has(value))
  ) {
    throw new TypeError(`${field} do not match the required matrix`);
  }
}

function compareCodePoints(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function runCli() {
  const args = parseArguments(process.argv.slice(2));
  const configuration = validateProjectConfiguration(
    JSON.parse(readFileSync(args.config, "utf8")),
  );
  if (args.database !== null) {
    const { openAdminDatabase, validateStoredProjectConfiguration } =
      await import("./generate-project-config.mjs");
    const database = openAdminDatabase(args.database);
    try {
      validateStoredProjectConfiguration({
        database,
        configuration,
        expectedWebhookMode: args.webhookMode,
        ...(args.environment === null ? {} : { environment: args.environment }),
        ...(args.forwardingMode === null
          ? {}
          : { expectedForwardingMode: args.forwardingMode }),
        ...(args.enabledAt === null ? {} : { enabledAt: args.enabledAt }),
      });
    } finally {
      database.close();
    }
  }
  process.stdout.write("Project configuration is valid.\n");
}

function parseArguments(argv) {
  let config = null;
  let database = null;
  let webhookMode = "disabled";
  let enabledAt = null;
  let environment = null;
  let forwardingMode = null;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`${flag} requires a value`);
    if (flag === "--config") config = value;
    else if (flag === "--database") database = value;
    else if (flag === "--webhook-mode") {
      webhookMode = enumValue(value, ["disabled", "live"], "webhook mode");
    } else if (flag === "--enabled-at") enabledAt = value;
    else if (flag === "--environment") {
      environment = enumValue(value, ENVIRONMENTS, "environment");
    } else if (flag === "--forwarding-mode") {
      forwardingMode = enumValue(
        value,
        ["disabled", "shadow"],
        "forwarding mode",
      );
    } else throw new Error(`unknown argument: ${flag}`);
    index += 1;
  }
  if (config === null) throw new Error("--config is required");
  if (webhookMode === "live" && enabledAt === null) {
    throw new Error("--enabled-at is required for live validation");
  }
  if (webhookMode === "disabled" && enabledAt !== null) {
    throw new Error("--enabled-at is valid only for live validation");
  }
  return {
    config,
    database,
    webhookMode,
    enabledAt,
    environment,
    forwardingMode,
  };
}

function isDirectExecution() {
  const entry = process.argv[1];
  return (
    entry !== undefined &&
    pathToFileURL(resolve(entry)).href === import.meta.url
  );
}

if (isDirectExecution()) {
  void runCli().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Project configuration validation failed"}\n`,
    );
    process.exitCode = 1;
  });
}

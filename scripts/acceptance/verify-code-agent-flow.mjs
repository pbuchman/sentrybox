import process from "node:process";
import { pathToFileURL } from "node:url";

import {
  CONTROLLED_ENVIRONMENT,
  CONTROLLED_PROJECT_SLUG,
  CONTROLLED_RELEASE,
  deriveControlledIdentity,
} from "./emit-controlled-issue.mjs";

const CODE_AGENT_DEV_BASE_URL = "https://dev.intexuraos.cloud/api/code";
const ORGANIZATION_SLUG = "intexuraos";
const MUTATION_CONFIRMATION = "delete-controlled-task-and-resolve-dev-issue";
const PHASES = new Set([
  "initial",
  "duplicate",
  "close",
  "regression",
  "completed",
]);

export function validateRuntimeConfiguration(environment) {
  const rawOrigin = requiredEnvironment(
    environment,
    "ERROR_HUB_PRIVATE_ORIGIN",
  );
  let hubOrigin;
  try {
    hubOrigin = new URL(rawOrigin);
  } catch {
    throw new TypeError("ERROR_HUB_PRIVATE_ORIGIN is not a URL");
  }
  if (
    hubOrigin.protocol !== "https:" ||
    !hubOrigin.hostname.endsWith(".ts.net") ||
    hubOrigin.port !== "8443" ||
    hubOrigin.username.length > 0 ||
    hubOrigin.password.length > 0 ||
    hubOrigin.pathname !== "/" ||
    hubOrigin.search.length > 0 ||
    hubOrigin.hash.length > 0 ||
    rawOrigin !== hubOrigin.origin
  ) {
    throw new TypeError(
      "ERROR_HUB_PRIVATE_ORIGIN must be the canonical Home Dev tailnet HTTPS origin on port 8443",
    );
  }
  const codeAgentBaseUrl = requiredEnvironment(
    environment,
    "CODE_AGENT_DEV_BASE_URL",
  );
  if (codeAgentBaseUrl !== CODE_AGENT_DEV_BASE_URL) {
    throw new TypeError("CODE_AGENT_DEV_BASE_URL must target development");
  }
  const authToken = requiredEnvironment(
    environment,
    "CODE_AGENT_DEV_AUTH_TOKEN",
  );
  if (authToken.trim() !== authToken || /\s/u.test(authToken)) {
    throw new TypeError("CODE_AGENT_DEV_AUTH_TOKEN is invalid");
  }
  return { hubOrigin, codeAgentBaseUrl, authToken };
}

export function validateAcceptanceSnapshot(input) {
  const phase = input.phase;
  if (!PHASES.has(phase) || phase === "close") {
    if (phase !== "close") throw new TypeError("verification phase is invalid");
  }
  const issue = record(input.issue, "SentryBox issue");
  const expectedGeneration = phase === "regression" ? 2 : 1;
  const expectedOccurrences = expectedGeneration;
  equal(issue.title, input.identity.title, "controlled issue title");
  equal(issue.status, "unresolved", "controlled issue status");
  equal(issue.generation, expectedGeneration, "controlled issue generation");
  equal(
    issue.occurrenceCount,
    expectedOccurrences,
    "controlled issue occurrence count",
  );
  const project = record(issue.project, "SentryBox issue project");
  equal(project.slug, CONTROLLED_PROJECT_SLUG, "controlled issue project");
  const facets = record(issue.facets, "SentryBox issue facets");
  requireFacet(
    facets.environment,
    CONTROLLED_ENVIRONMENT,
    expectedOccurrences,
    "environment",
  );
  requireFacet(
    facets.release,
    CONTROLLED_RELEASE,
    expectedOccurrences,
    "release",
  );

  const deliveries = array(issue.deliveries, "SentryBox deliveries");
  if (deliveries.length !== expectedGeneration) {
    throw new Error(
      `expected ${String(expectedGeneration)} SentryBox delivery row(s), received ${String(deliveries.length)}`,
    );
  }
  for (let generation = 1; generation <= expectedGeneration; generation += 1) {
    const delivery = deliveries.find(
      (candidate) =>
        record(candidate, "SentryBox delivery").generation === generation,
    );
    if (delivery === undefined) {
      throw new Error(
        `SentryBox delivery generation ${String(generation)} is missing`,
      );
    }
    equal(
      record(delivery, "SentryBox delivery").state,
      "delivered",
      `SentryBox delivery generation ${String(generation)} state`,
    );
  }

  const eventIds = new Set(
    array(input.events, "SentryBox events").map((value) => {
      const event = record(value, "SentryBox event");
      equal(
        event.environment,
        CONTROLLED_ENVIRONMENT,
        "SentryBox event environment",
      );
      equal(event.release, CONTROLLED_RELEASE, "SentryBox event release");
      return string(event.id, "SentryBox event id");
    }),
  );
  const initialId = deriveControlledIdentity(
    input.identity.runId,
    "initial",
  ).eventId;
  const expectedEventIds =
    phase === "regression"
      ? new Set([
          initialId,
          deriveControlledIdentity(input.identity.runId, "regression").eventId,
        ])
      : new Set([initialId]);
  equalSets(eventIds, expectedEventIds, "SentryBox event identities");

  const tasks = array(input.tasks, "Code Agent tasks");
  if (tasks.length !== 1) {
    throw new Error(
      `expected exactly one current controlled Code Task, received ${String(tasks.length)}`,
    );
  }
  const task = record(tasks[0], "Code Agent task");
  equal(task.agentType, "sentry", "Code Task agentType");
  equal(task.workerType, input.defaultWorkerType, "Code Task worker type");
  if (!string(task.prompt, "Code Task prompt").includes(input.issueUrl)) {
    throw new Error(
      "Code Task prompt does not contain the exact SentryBox issue URL",
    );
  }
  const taskId = string(task.id, "Code Task id");
  const linearIssueId = string(task.linearIssueId, "Linear issue id");
  const linearIssue = record(task.linearIssue, "hydrated Linear issue");
  equal(linearIssue.identifier, linearIssueId, "hydrated Linear identity");

  if (phase === "regression") {
    const priorTaskId = string(input.priorTaskId, "prior Code Task id");
    const priorLinearIssueId = string(
      input.priorLinearIssueId,
      "prior Linear issue id",
    );
    if (taskId === priorTaskId || linearIssueId === priorLinearIssueId) {
      throw new Error("regression reused the prior task or Linear issue");
    }
  }

  if (phase === "completed") {
    if (!new Set(["implemented", "reviewed"]).has(task.status)) {
      throw new Error("controlled Code Task has not completed successfully");
    }
    if (task.callbackReceived !== true) {
      throw new Error("controlled Code Task callback was not received");
    }
    const result = record(task.result, "Code Task result");
    equal(result.sentry_issue_url, input.issueUrl, "completion issue URL");
    if (!new Set(["fixed", "suppressed"]).has(result.sentry_outcome)) {
      throw new Error("completion outcome is not fixed or suppressed");
    }
    requireUrl(result.prUrl, "https:", "completion pull request URL");
    requireUrl(
      result.sentry_linear_issue,
      "https:",
      "completion Linear issue URL",
    );
    string(result.sentry_verification, "completion verification");
  }

  return {
    issueId: positiveInteger(issue.id, "SentryBox issue id"),
    issueUrl: input.issueUrl,
    taskId,
    linearIssueId,
    generation: expectedGeneration,
    occurrenceCount: expectedOccurrences,
  };
}

export async function runAcceptanceVerification(options) {
  const runtime = validateRuntimeConfiguration(options.environment);
  const identity = deriveControlledIdentity(
    options.runId,
    options.phase === "close" || options.phase === "completed"
      ? "initial"
      : options.phase,
  );
  const deadline = Date.now() + options.waitSeconds * 1_000;
  let latestError;
  while (Date.now() <= deadline) {
    try {
      const snapshot = await loadAcceptanceSnapshot({
        runtime,
        identity,
        fetchImpl: options.fetchImpl ?? globalThis.fetch,
      });
      const validated = validateAcceptanceSnapshot({
        phase: options.phase,
        identity,
        ...snapshot,
        priorTaskId: options.priorTaskId,
        priorLinearIssueId: options.priorLinearIssueId,
      });
      if (options.phase !== "close") return validated;
      return await closeControlledTransition({
        runtime,
        validated,
        environment: options.environment,
        fetchImpl: options.fetchImpl ?? globalThis.fetch,
      });
    } catch (error) {
      latestError = error;
      if (Date.now() >= deadline || options.phase === "close") break;
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }
  throw latestError instanceof Error
    ? latestError
    : new Error("acceptance verification timed out");
}

async function loadAcceptanceSnapshot({ runtime, identity, fetchImpl }) {
  if (typeof fetchImpl !== "function") {
    throw new TypeError("fetch implementation is unavailable");
  }
  const issueListUrl = new URL("/api/issues", runtime.hubOrigin);
  issueListUrl.searchParams.set("project", CONTROLLED_PROJECT_SLUG);
  issueListUrl.searchParams.set("environment", CONTROLLED_ENVIRONMENT);
  issueListUrl.searchParams.set("release", CONTROLLED_RELEASE);
  issueListUrl.searchParams.set("query", identity.runId);
  issueListUrl.searchParams.set("limit", "100");
  const issueList = record(
    await fetchJson(fetchImpl, issueListUrl, {}),
    "SentryBox issue list",
  );
  const matchingIssues = array(
    issueList.items,
    "SentryBox issue list items",
  ).filter(
    (value) =>
      record(value, "SentryBox issue list item").title === identity.title,
  );
  if (matchingIssues.length !== 1) {
    throw new Error(
      `expected exactly one controlled SentryBox issue, received ${String(matchingIssues.length)}`,
    );
  }
  const issueId = positiveInteger(
    record(matchingIssues[0], "SentryBox issue list item").id,
    "SentryBox issue id",
  );
  const [issue, events, settings, tasks] = await Promise.all([
    fetchJson(
      fetchImpl,
      new URL(`/api/issues/${String(issueId)}`, runtime.hubOrigin),
      {},
    ),
    fetchJson(
      fetchImpl,
      new URL(
        `/api/issues/${String(issueId)}/events?limit=100`,
        runtime.hubOrigin,
      ),
      {},
    ),
    fetchCodeAgent(fetchImpl, runtime, "/worker-settings"),
    listCodeAgentTasks(fetchImpl, runtime),
  ]);
  const settingsRecord = record(settings, "worker settings");
  const defaultWorkerType = string(
    settingsRecord.defaultSentryWorkerType,
    "defaultSentryWorkerType",
  );
  const issueUrl = new URL(
    `/organizations/${ORGANIZATION_SLUG}/issues/${String(issueId)}/`,
    runtime.hubOrigin,
  ).toString();
  return {
    issue,
    events: array(
      record(events, "SentryBox events page").items,
      "SentryBox events",
    ),
    tasks: tasks.filter((value) =>
      string(
        record(value, "Code Agent task").prompt,
        "Code Task prompt",
      ).includes(issueUrl),
    ),
    defaultWorkerType,
    issueUrl,
  };
}

async function closeControlledTransition({
  runtime,
  validated,
  environment,
  fetchImpl,
}) {
  if (
    environment.ERROR_HUB_ACCEPTANCE_ALLOW_CONTROLLED_MUTATION !==
    MUTATION_CONFIRMATION
  ) {
    throw new Error(
      `close phase requires ERROR_HUB_ACCEPTANCE_ALLOW_CONTROLLED_MUTATION=${MUTATION_CONFIRMATION}`,
    );
  }
  await fetchCodeAgent(
    fetchImpl,
    runtime,
    `/tasks/${encodeURIComponent(validated.taskId)}`,
    { method: "DELETE" },
  );
  const resolved = record(
    await fetchJson(
      fetchImpl,
      new URL(
        `/api/issues/${String(validated.issueId)}/resolve`,
        runtime.hubOrigin,
      ),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: runtime.hubOrigin.origin,
        },
        body: "{}",
      },
    ),
    "resolved SentryBox issue",
  );
  equal(resolved.status, "resolved", "resolved SentryBox issue status");
  return { ...validated, status: "resolved", controlledTaskDeleted: true };
}

async function listCodeAgentTasks(fetchImpl, runtime) {
  const tasks = [];
  let cursor = null;
  for (let page = 0; page < 10; page += 1) {
    const query = new URLSearchParams({ limit: "100" });
    if (cursor !== null) query.set("cursor", cursor);
    const result = record(
      await fetchCodeAgent(fetchImpl, runtime, `/tasks?${query.toString()}`),
      "Code Agent task page",
    );
    tasks.push(...array(result.tasks, "Code Agent tasks"));
    cursor =
      result.nextCursor === undefined
        ? null
        : string(result.nextCursor, "Code Agent next cursor");
    if (cursor === null) return tasks;
  }
  throw new Error("Code Agent task pagination exceeded the acceptance bound");
}

async function fetchCodeAgent(fetchImpl, runtime, path, options = {}) {
  const response = record(
    await fetchJson(fetchImpl, new URL(`${runtime.codeAgentBaseUrl}${path}`), {
      ...options,
      headers: {
        ...options.headers,
        Authorization: `Bearer ${runtime.authToken}`,
      },
    }),
    "Code Agent response",
  );
  if (response.success !== true) throw new Error("Code Agent request failed");
  return response.data;
}

async function fetchJson(fetchImpl, url, options) {
  const response = await fetchImpl(url, {
    ...options,
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(
      `request to ${url.origin}${url.pathname} failed with HTTP ${String(response.status)}`,
    );
  }
  if (response.status === 204) return {};
  return await response.json();
}

export function parseArguments(argv) {
  let phase = null;
  let runId = null;
  let priorTaskId;
  let priorLinearIssueId;
  let waitSeconds = 120;
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (value === undefined) throw new TypeError(`${flag} requires a value`);
    if (flag === "--phase") phase = value;
    else if (flag === "--run-id") runId = value;
    else if (flag === "--prior-task-id") priorTaskId = value;
    else if (flag === "--prior-linear-issue-id") priorLinearIssueId = value;
    else if (flag === "--wait-seconds") waitSeconds = Number(value);
    else throw new TypeError(`unknown argument: ${flag}`);
  }
  if (phase === null || !PHASES.has(phase)) {
    throw new TypeError("--phase is required and must be valid");
  }
  if (runId === null) throw new TypeError("--run-id is required");
  if (
    !Number.isSafeInteger(waitSeconds) ||
    waitSeconds < 0 ||
    waitSeconds > 300
  ) {
    throw new TypeError("--wait-seconds must be an integer from 0 to 300");
  }
  if (
    phase === "regression" &&
    (priorTaskId === undefined || priorLinearIssueId === undefined)
  ) {
    throw new TypeError(
      "regression requires --prior-task-id and --prior-linear-issue-id",
    );
  }
  return {
    phase,
    runId,
    waitSeconds,
    ...(priorTaskId === undefined ? {} : { priorTaskId }),
    ...(priorLinearIssueId === undefined ? {} : { priorLinearIssueId }),
  };
}

function requireFacet(value, expectedValue, expectedCount, field) {
  const match = array(value, `${field} facets`).find((candidate) => {
    const facet = record(candidate, `${field} facet`);
    return facet.value === expectedValue && facet.count === expectedCount;
  });
  if (match === undefined) {
    throw new Error(
      `${field} facet does not contain ${expectedValue} with count ${String(expectedCount)}`,
    );
  }
}

function requiredEnvironment(environment, key) {
  const value = environment[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${key} is required`);
  }
  return value;
}

function record(value, field) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value;
}

function array(value, field) {
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array`);
  return value;
}

function string(value, field) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value;
}

function positiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${field} must be a positive integer`);
  }
  return value;
}

function equal(actual, expected, field) {
  if (actual !== expected) {
    throw new Error(
      `${field} mismatch: expected ${String(expected)}, received ${String(actual)}`,
    );
  }
}

function equalSets(actual, expected, field) {
  if (
    actual.size !== expected.size ||
    [...actual].some((value) => !expected.has(value))
  ) {
    throw new Error(`${field} do not match the controlled run`);
  }
}

function requireUrl(value, protocol, field) {
  const text = string(value, field);
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new TypeError(`${field} must be a URL`);
  }
  if (url.protocol !== protocol) throw new TypeError(`${field} is invalid`);
  return url;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const result = await runAcceptanceVerification({
    ...options,
    environment: process.env,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "acceptance verification failed"}\n`,
    );
    process.exitCode = 1;
  });
}

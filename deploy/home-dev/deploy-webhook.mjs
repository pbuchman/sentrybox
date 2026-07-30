#!/usr/bin/env node

import { Buffer } from "node:buffer";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

export const MAX_BODY_BYTES = 1024 * 1024;

const LISTEN_HOST = "127.0.0.1";
const LISTEN_PORT = 9003;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_EVENT_AGE_MS = 5 * 60_000;
const MAX_FUTURE_SKEW_MS = 30_000;
const DELIVERY_RETENTION_MS = 7 * 24 * 60 * 60_000;
const EXPECTED_REPOSITORY = "pbuchman/sentrybox";
const EXPECTED_WORKFLOW = "Release SentryBox Image";
const SECRET_FILE =
  "/run/credentials/sentrybox-deploy-webhook.service/github-webhook-secret";
const DELIVERY_STORE = "/var/lib/sentrybox-deploy/deliveries.json";
const DEPLOY_REQUEST = "/var/lib/sentrybox-deploy/deploy-request.json";
const DEPLOY_UNIT = "sentrybox-deploy.service";
const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const DELIVERY_PATTERN = /^[A-Za-z0-9._-]{1,128}$/u;
const SIGNATURE_PATTERN = /^sha256=([0-9a-f]{64})$/u;

export class DeliveryStore {
  #path;
  #now;
  #deliveries;

  constructor(path, now = () => new Date()) {
    if (typeof path !== "string" || path.length === 0) {
      throw new TypeError("delivery store path must not be empty");
    }
    this.#path = path;
    this.#now = now;
    this.#deliveries = loadDeliveries(path);
    this.#prune();
  }

  has(id) {
    this.#prune();
    return this.#deliveries.has(id);
  }

  record(id, sha) {
    if (!DELIVERY_PATTERN.test(id)) {
      throw new TypeError("delivery id is invalid");
    }
    if (!SHA_PATTERN.test(sha)) {
      throw new TypeError("delivery SHA is invalid");
    }
    this.#prune();
    if (this.#deliveries.has(id)) {
      throw new Error("delivery replay rejected");
    }
    const acceptedAt = canonicalNow(this.#now).toISOString();
    this.#deliveries.set(id, { id, sha, acceptedAt });
    try {
      persistDeliveries(this.#path, this.#deliveries.values());
    } catch (error) {
      this.#deliveries.delete(id);
      throw error;
    }
  }

  #prune() {
    const cutoff = canonicalNow(this.#now).getTime() - DELIVERY_RETENTION_MS;
    for (const [id, delivery] of this.#deliveries) {
      if (Date.parse(delivery.acceptedAt) < cutoff) {
        this.#deliveries.delete(id);
      }
    }
  }
}

export function verifyGitHubSignature(body, signature, secret) {
  if (
    !Buffer.isBuffer(body) ||
    typeof secret !== "string" ||
    secret.length < 32
  ) {
    return false;
  }
  if (typeof signature !== "string") return false;
  const match = SIGNATURE_PATTERN.exec(signature);
  if (match === null) return false;
  const supplied = Buffer.from(match[1], "hex");
  const expected = createHmac("sha256", secret).update(body).digest();
  return (
    supplied.length === expected.length && timingSafeEqual(supplied, expected)
  );
}

export function validateWorkflowRun(value, now = new Date()) {
  const payload = record(value, "payload");
  const repository = record(payload.repository, "repository");
  if (repository.full_name !== EXPECTED_REPOSITORY) {
    throw new TypeError("repository does not match SentryBox");
  }
  if (payload.action !== "completed") {
    throw new TypeError("action must be completed");
  }
  const workflow = record(payload.workflow_run, "workflow_run");
  if (workflow.name !== EXPECTED_WORKFLOW) {
    throw new TypeError("workflow name does not match the release workflow");
  }
  if (workflow.event !== "push") {
    throw new TypeError("event must be push");
  }
  if (workflow.head_branch !== "main") {
    throw new TypeError("branch must be main");
  }
  if (workflow.conclusion !== "success") {
    throw new TypeError("conclusion must be success");
  }
  if (
    typeof workflow.head_sha !== "string" ||
    !SHA_PATTERN.test(workflow.head_sha)
  ) {
    throw new TypeError("sha must be 40 lowercase hexadecimal characters");
  }
  if (typeof workflow.updated_at !== "string") {
    throw new TypeError("updated timestamp is missing");
  }
  const updated = Date.parse(workflow.updated_at);
  if (!Number.isFinite(updated)) {
    throw new TypeError("updated timestamp is invalid");
  }
  const current = canonicalNow(() => now).getTime();
  if (updated < current - MAX_EVENT_AGE_MS) {
    throw new TypeError("stale workflow event rejected");
  }
  if (updated > current + MAX_FUTURE_SKEW_MS) {
    throw new TypeError("future workflow event rejected");
  }
  return {
    headSha: workflow.head_sha,
    updatedAt: new Date(updated).toISOString(),
  };
}

export function createDeployWebhookServer(options) {
  if (typeof options.secret !== "string" || options.secret.length < 32) {
    throw new TypeError(
      "deployment webhook secret must contain at least 32 bytes",
    );
  }
  const now = options.now ?? (() => new Date());
  const log = options.log ?? structuredLog;
  let deploymentInProgress = false;
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== "POST" || request.url !== "/github/workflow-run") {
        send(response, 404, "not found");
        return;
      }
      if (header(request, "x-github-event") !== "workflow_run") {
        send(response, 400, "invalid event");
        return;
      }
      const contentType = header(request, "content-type");
      if (contentType?.split(";", 1)[0]?.trim() !== "application/json") {
        send(response, 415, "invalid content type");
        return;
      }
      const deliveryId = header(request, "x-github-delivery");
      if (deliveryId === undefined || !DELIVERY_PATTERN.test(deliveryId)) {
        send(response, 400, "invalid delivery");
        return;
      }
      const body = await readRequestBody(request);
      if (
        !verifyGitHubSignature(
          body,
          header(request, "x-hub-signature-256"),
          options.secret,
        )
      ) {
        send(response, 401, "invalid signature");
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(body.toString("utf8"));
      } catch {
        send(response, 400, "invalid payload");
        return;
      }
      let workflow;
      try {
        workflow = validateWorkflowRun(parsed, canonicalNow(now));
      } catch {
        send(response, 400, "invalid workflow");
        return;
      }
      if (options.deliveryStore.has(deliveryId)) {
        send(response, 409, "delivery replay rejected");
        return;
      }
      if (deploymentInProgress) {
        send(response, 409, "deployment in progress");
        return;
      }
      options.deliveryStore.record(deliveryId, workflow.headSha);
      deploymentInProgress = true;
      let deployment;
      try {
        deployment = Promise.resolve(options.invokeDeploy(workflow.headSha));
      } catch (error) {
        deploymentInProgress = false;
        log({
          level: "error",
          event: "deployment_start_failed",
          deliveryId,
          headSha: workflow.headSha,
          error: safeError(error),
        });
        send(response, 500, "deployment start failed");
        return;
      }
      send(response, 202, "accepted");
      void deployment
        .then(() => {
          log({
            level: "info",
            event: "deployment_completed",
            deliveryId,
            headSha: workflow.headSha,
          });
        })
        .catch((error) => {
          log({
            level: "error",
            event: "deployment_failed",
            deliveryId,
            headSha: workflow.headSha,
            error: safeError(error),
          });
        })
        .finally(() => {
          deploymentInProgress = false;
        });
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        send(response, 413, "payload too large");
        return;
      }
      log({
        level: "error",
        event: "webhook_request_failed",
        error: safeError(error),
      });
      send(response, 500, "request failed");
    }
  });
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.headersTimeout = REQUEST_TIMEOUT_MS;
  server.keepAliveTimeout = 1_000;
  return server;
}

class BodyTooLargeError extends Error {}

async function readRequestBody(request) {
  const contentLength = request.headers["content-length"];
  let tooLarge =
    typeof contentLength === "string" &&
    /^\d+$/u.test(contentLength) &&
    Number(contentLength) > MAX_BODY_BYTES;
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_BODY_BYTES) {
      tooLarge = true;
      chunks.length = 0;
      continue;
    }
    if (!tooLarge) chunks.push(buffer);
  }
  if (tooLarge) throw new BodyTooLargeError("request body exceeds one MiB");
  return Buffer.concat(chunks, bytes);
}

function header(request, name) {
  const value = request.headers[name];
  return typeof value === "string" ? value : undefined;
}

function send(response, status, message) {
  if (response.headersSent || response.destroyed) return;
  const body = JSON.stringify({ status: message });
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "x-sentrybox-deploy-handler": "workflow-run-v1",
    connection: "close",
  });
  response.end(body);
}

function loadDeliveries(path) {
  if (!existsSync(path)) return new Map();
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (
    value === null ||
    typeof value !== "object" ||
    value.version !== 1 ||
    !Array.isArray(value.deliveries)
  ) {
    throw new Error("deployment delivery store is invalid");
  }
  const deliveries = new Map();
  for (const candidate of value.deliveries) {
    const delivery = record(candidate, "stored delivery");
    if (
      typeof delivery.id !== "string" ||
      !DELIVERY_PATTERN.test(delivery.id) ||
      typeof delivery.sha !== "string" ||
      !SHA_PATTERN.test(delivery.sha) ||
      typeof delivery.acceptedAt !== "string" ||
      !Number.isFinite(Date.parse(delivery.acceptedAt)) ||
      deliveries.has(delivery.id)
    ) {
      throw new Error("deployment delivery store contains an invalid record");
    }
    deliveries.set(delivery.id, {
      id: delivery.id,
      sha: delivery.sha,
      acceptedAt: new Date(delivery.acceptedAt).toISOString(),
    });
  }
  return deliveries;
}

function persistDeliveries(path, deliveries) {
  const rows = [...deliveries].sort((left, right) =>
    left.acceptedAt < right.acceptedAt
      ? -1
      : left.acceptedAt > right.acceptedAt
        ? 1
        : left.id < right.id
          ? -1
          : 1,
  );
  const temporary = `${path}.${String(process.pid)}.${randomUUID()}.tmp`;
  let file = null;
  try {
    file = openSync(temporary, "wx", 0o600);
    writeFileSync(
      file,
      `${JSON.stringify({ version: 1, deliveries: rows })}\n`,
    );
    fsyncSync(file);
    closeSync(file);
    file = null;
    renameSync(temporary, path);
    const directory = openSync(dirname(path), "r");
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  } catch (error) {
    if (file !== null) closeSync(file);
    try {
      unlinkSync(temporary);
    } catch (cleanupError) {
      if (!isNotFound(cleanupError)) throw cleanupError;
    }
    throw error;
  }
}

function record(value, field) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value;
}

function canonicalNow(now) {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError("current time is invalid");
  }
  return new Date(value.getTime());
}

function safeError(error) {
  return error instanceof Error ? error.message.slice(0, 256) : "unknown error";
}

function structuredLog(entry) {
  process.stdout.write(
    `${JSON.stringify({ timestamp: new Date().toISOString(), ...entry })}\n`,
  );
}

function readSecret(path) {
  const status = statSync(path);
  if (!status.isFile() || (status.mode & 0o077) !== 0) {
    throw new Error(
      "deployment webhook secret file must be a mode-0600 regular file",
    );
  }
  const secret = readFileSync(path, "utf8").replace(/\r?\n$/u, "");
  if (
    Buffer.byteLength(secret) < 32 ||
    secret.includes("\n") ||
    secret.includes("\r")
  ) {
    throw new Error(
      "deployment webhook secret must contain one value of at least 32 bytes",
    );
  }
  return secret;
}

function invokeFixedDeploy(headSha) {
  writeDeployRequest(headSha);
  return startFixedDeploy().catch((error) => {
    removeDeployRequest();
    throw error;
  });
}

export function startFixedDeploy(requestPath = DEPLOY_REQUEST) {
  return new Promise((resolveDeploy, rejectDeploy) => {
    const child = spawn(
      "/usr/bin/systemctl",
      ["--wait", "start", DEPLOY_UNIT],
      {
        cwd: "/",
        shell: false,
        stdio: ["ignore", "inherit", "inherit"],
        env: {
          PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        },
      },
    );
    child.once("error", rejectDeploy);
    child.once("exit", (code, signal) => {
      if (code === 0 && !existsSync(requestPath)) {
        resolveDeploy();
      } else {
        rejectDeploy(
          new Error(
            `fixed deployment unit failed (${code === null ? signal : String(code)})`,
          ),
        );
      }
    });
  });
}

export function writeDeployRequest(headSha, requestPath = DEPLOY_REQUEST) {
  const file = openSync(requestPath, "wx", 0o600);
  try {
    writeFileSync(
      file,
      `${JSON.stringify({
        version: 1,
        repository: EXPECTED_REPOSITORY,
        workflow: EXPECTED_WORKFLOW,
        headSha,
      })}\n`,
    );
    fsyncSync(file);
  } catch (error) {
    closeSync(file);
    removeDeployRequest(requestPath);
    throw error;
  }
  closeSync(file);
}

export function removeDeployRequest(requestPath = DEPLOY_REQUEST) {
  try {
    unlinkSync(requestPath);
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

function isNotFound(error) {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

async function runMain() {
  const secret = readSecret(SECRET_FILE);
  const deliveryStore = new DeliveryStore(DELIVERY_STORE);
  const server = createDeployWebhookServer({
    secret,
    deliveryStore,
    invokeDeploy: invokeFixedDeploy,
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(LISTEN_PORT, LISTEN_HOST, resolveListen);
  });
  structuredLog({ level: "info", event: "deploy_webhook_listening" });
  await new Promise((resolveClose, rejectClose) => {
    let closing = false;
    const close = () => {
      if (closing) return;
      closing = true;
      server.close((error) =>
        error === undefined ? resolveClose() : rejectClose(error),
      );
    };
    process.once("SIGINT", close);
    process.once("SIGTERM", close);
  });
}

function isDirectExecution() {
  const entry = process.argv[1];
  return (
    entry !== undefined &&
    pathToFileURL(resolve(entry)).href === import.meta.url
  );
}

if (isDirectExecution()) {
  void runMain().catch((error) => {
    structuredLog({
      level: "error",
      event: "deploy_webhook_fatal",
      error: safeError(error),
    });
    process.exitCode = 1;
  });
}

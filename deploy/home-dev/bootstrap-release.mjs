#!/usr/bin/env node

import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  unlinkSync,
} from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import {
  removeDeployRequest,
  startFixedDeploy,
  writeDeployRequest,
} from "./deploy-webhook.mjs";

const require = createRequire(import.meta.url);
const { request: httpsRequest } = require("node:https");

const CHECKOUT = "/home/pbuchman/deploy/sentrybox";
const EXPECTED_REPOSITORY = "pbuchman/sentrybox";
const EXPECTED_WORKFLOW = "Release SentryBox Image";
const TOKEN_FILE = "/var/lib/sentrybox-deploy/bootstrap-github-token";
const TOKEN_PARENT_MODES = new Map([
  ["/", 0o755],
  ["/var", 0o755],
  ["/var/lib", 0o755],
  ["/var/lib/sentrybox-deploy", 0o700],
]);
const DEPLOY_REQUEST = "/var/lib/sentrybox-deploy/deploy-request.json";
const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const WORKFLOW_RUNS_URL =
  "https://api.github.com/repos/pbuchman/sentrybox/actions/workflows/release-image.yml/runs?event=push&status=completed&per_page=100";
const GITHUB_REQUEST_TIMEOUT_MS = 10_000;
const MAX_GITHUB_RESPONSE_BYTES = 4 * 1024 * 1024;

export async function bootstrapFirstRelease({
  token,
  currentMainSha,
  fetchImpl = githubFetch,
  requestPath = DEPLOY_REQUEST,
  startDeploy,
  removeBootstrapToken,
}) {
  if (typeof token !== "string" || token.length === 0) {
    throw new TypeError("GitHub bootstrap token is required");
  }
  if (typeof currentMainSha !== "string" || !SHA_PATTERN.test(currentMainSha)) {
    throw new TypeError("current origin/main SHA is invalid");
  }

  const response = await fetchImpl(WORKFLOW_RUNS_URL, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "SentryBox-Home-Dev-bootstrap",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!response.ok) {
    throw new Error(
      `GitHub release lookup failed (${String(response.status)})`,
    );
  }

  const selected = selectSuccessfulCurrentMainRelease(
    await response.json(),
    currentMainSha,
  );
  writeDeployRequest(selected.headSha, requestPath);
  try {
    if (startDeploy === undefined) {
      await startFixedDeploy(requestPath);
    } else {
      await startDeploy();
    }
    if (existsSync(requestPath)) {
      throw new Error("fixed deployment unit did not consume its request");
    }
  } catch (error) {
    removeDeployRequest(requestPath);
    throw error;
  }
  if (removeBootstrapToken !== undefined) {
    await removeBootstrapToken();
  }
  return selected;
}

export function githubFetch(url, options = {}, requestImpl = httpsRequest) {
  if (url !== WORKFLOW_RUNS_URL) {
    return Promise.reject(
      new Error("GitHub release lookup URL is not canonical"),
    );
  }
  if (
    options === null ||
    typeof options !== "object" ||
    options.headers === null ||
    typeof options.headers !== "object"
  ) {
    return Promise.reject(new TypeError("GitHub request headers are required"));
  }
  return new Promise((resolveRequest, rejectRequest) => {
    let settled = false;
    let request;
    const rejectOnce = (error) => {
      if (settled) return;
      settled = true;
      rejectRequest(error);
    };
    try {
      request = requestImpl(
        url,
        { method: "GET", headers: options.headers },
        (response) => {
          const status = response.statusCode;
          if (!Number.isInteger(status) || status < 100 || status > 599) {
            response.resume?.();
            rejectOnce(new Error("GitHub release lookup returned no status"));
            return;
          }
          const chunks = [];
          let bytes = 0;
          response.on("error", rejectOnce);
          response.on("data", (chunk) => {
            if (settled) return;
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            bytes += buffer.length;
            if (bytes > MAX_GITHUB_RESPONSE_BYTES) {
              rejectOnce(
                new Error("GitHub release lookup response is too large"),
              );
              request.destroy();
              response.destroy?.();
              return;
            }
            chunks.push(buffer);
          });
          response.on("end", () => {
            if (settled) return;
            settled = true;
            const body = Buffer.concat(chunks, bytes).toString("utf8");
            resolveRequest({
              ok: status >= 200 && status < 300,
              status,
              json: async () => JSON.parse(body),
            });
          });
        },
      );
      request.once("error", rejectOnce);
      request.setTimeout(GITHUB_REQUEST_TIMEOUT_MS, () => {
        request.destroy(new Error("GitHub release lookup timed out"));
      });
      request.end();
    } catch (error) {
      rejectOnce(error);
    }
  });
}

export function selectSuccessfulCurrentMainRelease(payload, currentMainSha) {
  if (
    payload === null ||
    typeof payload !== "object" ||
    !Array.isArray(payload.workflow_runs) ||
    typeof currentMainSha !== "string" ||
    !SHA_PATTERN.test(currentMainSha)
  ) {
    throw new TypeError("successful canonical push release was not found");
  }
  for (const candidate of payload.workflow_runs) {
    if (isSuccessfulCurrentMainRelease(candidate, currentMainSha)) {
      return { headSha: currentMainSha };
    }
  }
  throw new TypeError("successful canonical push release was not found");
}

function isSuccessfulCurrentMainRelease(value, currentMainSha) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const repository = value.repository;
  return (
    repository !== null &&
    typeof repository === "object" &&
    !Array.isArray(repository) &&
    repository.full_name === EXPECTED_REPOSITORY &&
    value.name === EXPECTED_WORKFLOW &&
    value.path === ".github/workflows/release-image.yml" &&
    Number.isSafeInteger(value.workflow_id) &&
    value.workflow_id > 0 &&
    value.event === "push" &&
    value.head_branch === "main" &&
    value.status === "completed" &&
    value.conclusion === "success" &&
    value.head_sha === currentMainSha
  );
}

export function readBootstrapToken(
  path,
  {
    close = closeSync,
    fstat = fstatSync,
    lstat = lstatSync,
    open = openSync,
    readFile = readFileSync,
  } = {},
) {
  if (path !== TOKEN_FILE) {
    throw new Error("GitHub bootstrap token source path is not canonical");
  }

  for (const [parent, expectedMode] of TOKEN_PARENT_MODES) {
    const metadata = lstat(parent);
    if (
      metadata.isDirectory?.() !== true ||
      metadata.uid !== 0 ||
      metadata.gid !== 0 ||
      (metadata.mode & 0o777) !== expectedMode
    ) {
      throw new Error(
        "GitHub bootstrap token must use a root-owned bootstrap token source directory with its fixed safe mode",
      );
    }
  }

  const pathMetadata = lstat(path);
  assertSafeTokenFile(pathMetadata);

  const flags =
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  const descriptor = open(path, flags);
  try {
    const descriptorMetadata = fstat(descriptor);
    assertSafeTokenFile(descriptorMetadata);
    if (
      descriptorMetadata.dev !== pathMetadata.dev ||
      descriptorMetadata.ino !== pathMetadata.ino
    ) {
      throw new Error(
        "GitHub bootstrap token source changed while it was being opened",
      );
    }

    const token = readFile(descriptor, "utf8").replace(/\r?\n$/u, "");
    if (token.length === 0 || token.includes("\n") || token.includes("\r")) {
      throw new Error(
        "GitHub bootstrap token must contain one non-empty value",
      );
    }
    return token;
  } finally {
    close(descriptor);
  }
}

function assertSafeTokenFile(file) {
  if (
    file.isFile?.() !== true ||
    file.uid !== 0 ||
    file.gid !== 0 ||
    file.nlink !== 1 ||
    (file.mode & 0o777) !== 0o600
  ) {
    throw new Error(
      "GitHub bootstrap token must be a root-owned, mode 0600, singly linked regular file",
    );
  }
}

export function currentCanonicalMainSha(runGit = runCanonicalGit) {
  const remote = runGit(["remote", "get-url", "origin"]);
  if (
    remote !== "https://github.com/pbuchman/sentrybox.git" &&
    remote !== "git@github.com:pbuchman/sentrybox.git"
  ) {
    throw new Error("canonical SentryBox checkout has an unexpected origin");
  }
  const listing = runGit([
    "ls-remote",
    "--exit-code",
    "origin",
    "refs/heads/main",
  ]);
  const match = listing.match(/^([0-9a-f]{40})\trefs\/heads\/main$/u);
  if (match === null) {
    throw new Error("current origin/main SHA is invalid");
  }
  return match[1];
}

function runCanonicalGit(args) {
  return execFileSync(
    "/usr/bin/git",
    ["-c", `safe.directory=${CHECKOUT}`, "-C", CHECKOUT, ...args],
    { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  ).trim();
}

async function runMain() {
  const currentMainSha = currentCanonicalMainSha();
  const selected = await bootstrapFirstRelease({
    token: readBootstrapToken(TOKEN_FILE),
    currentMainSha,
    removeBootstrapToken: () => unlinkSync(TOKEN_FILE),
  });
  process.stdout.write(
    `SentryBox first deployment requested at ${selected.headSha}.\n`,
  );
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
    process.stderr.write(
      `${error instanceof Error ? error.message : "bootstrap failed"}\n`,
    );
    process.exitCode = 1;
  });
}

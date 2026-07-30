#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import {
  removeDeployRequest,
  startFixedDeploy,
  writeDeployRequest,
} from "./deploy-webhook.mjs";

const CHECKOUT = "/home/pbuchman/deploy/sentrybox";
const EXPECTED_REPOSITORY = "pbuchman/sentrybox";
const EXPECTED_WORKFLOW = "Release SentryBox Image";
const TOKEN_FILE =
  "/run/credentials/sentrybox-deploy-bootstrap.service/github-bootstrap-token";
const DEPLOY_REQUEST = "/var/lib/sentrybox-deploy/deploy-request.json";
const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const WORKFLOW_RUNS_URL =
  "https://api.github.com/repos/pbuchman/sentrybox/actions/workflows/release-image.yml/runs?event=push&status=completed&per_page=100";

export async function bootstrapFirstRelease({
  token,
  currentMainSha,
  fetchImpl = fetch,
  requestPath = DEPLOY_REQUEST,
  startDeploy,
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
  return selected;
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
  { lstat = lstatSync, readFile = readFileSync } = {},
) {
  const file = lstat(path);
  const permissions = file.mode & 0o777;
  if (
    !file.isFile() ||
    file.uid !== 0 ||
    file.gid !== 0 ||
    file.nlink !== 1 ||
    (permissions !== 0o400 && permissions !== 0o600)
  ) {
    throw new Error(
      "GitHub bootstrap token must be a root-owned, private, singly linked regular file",
    );
  }
  const token = readFile(path, "utf8").replace(/\r?\n$/u, "");
  if (token.length === 0 || token.includes("\n") || token.includes("\r")) {
    throw new Error("GitHub bootstrap token must contain one non-empty value");
  }
  return token;
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

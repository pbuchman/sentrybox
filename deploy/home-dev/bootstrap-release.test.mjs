import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  bootstrapFirstRelease,
  currentCanonicalMainSha,
  readBootstrapToken,
} from "./bootstrap-release.mjs";

const SHA = "1234567890abcdef1234567890abcdef12345678";
const OTHER_SHA = "abcdef1234567890abcdef1234567890abcdef12";
const WORKFLOW_RUNS_URL =
  "https://api.github.com/repos/pbuchman/sentrybox/actions/workflows/release-image.yml/runs?event=push&status=completed&per_page=100";

test("bootstrap selects the exact current canonical release and submits the canonical request", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sentrybox-bootstrap-"));
  const requestPath = join(directory, "deploy-request.json");
  let requestedUrl;
  let requestedOptions;
  let capturedRequest;
  try {
    const selected = await bootstrapFirstRelease({
      token: "test-token-held-only-in-memory",
      currentMainSha: SHA,
      requestPath,
      fetchImpl: async (url, options) => {
        requestedUrl = url;
        requestedOptions = options;
        return response({ workflow_runs: [workflowRun()] });
      },
      startDeploy: async () => {
        capturedRequest = JSON.parse(await readFile(requestPath, "utf8"));
        await unlink(requestPath);
      },
    });

    assert.deepEqual(selected, { headSha: SHA });
    assert.deepEqual(capturedRequest, {
      version: 1,
      repository: "pbuchman/sentrybox",
      workflow: "Release SentryBox Image",
      headSha: SHA,
    });
    assert.equal(requestedUrl, WORKFLOW_RUNS_URL);
    assert.equal(
      requestedUrl.includes("test-token-held-only-in-memory"),
      false,
    );
    assert.deepEqual(requestedOptions, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: "Bearer test-token-held-only-in-memory",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    assert.equal(existsSync(requestPath), false);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("bootstrap rejects every non-canonical workflow identity before creating a request", async () => {
  const invalid = [
    ["repository", (run) => (run.repository.full_name = "attacker/repo")],
    ["workflow", (run) => (run.name = "CI")],
    ["workflow path", (run) => (run.path = ".github/workflows/ci.yml")],
    ["workflow id", (run) => (run.workflow_id = "not-a-number")],
    ["event", (run) => (run.event = "workflow_dispatch")],
    ["branch", (run) => (run.head_branch = "feature")],
    ["status", (run) => (run.status = "in_progress")],
    ["conclusion", (run) => (run.conclusion = "failure")],
    ["sha", (run) => (run.head_sha = OTHER_SHA)],
  ];

  for (const [name, mutate] of invalid) {
    const directory = await mkdtemp(join(tmpdir(), "sentrybox-bootstrap-"));
    const requestPath = join(directory, "deploy-request.json");
    const run = workflowRun();
    mutate(run);
    try {
      await assert.rejects(
        bootstrapFirstRelease({
          token: "test-token-held-only-in-memory",
          currentMainSha: SHA,
          requestPath,
          fetchImpl: async () => response({ workflow_runs: [run] }),
          startDeploy: async () => assert.fail("must not start deployment"),
        }),
        /successful canonical push release/u,
        name,
      );
      assert.equal(existsSync(requestPath), false, name);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }
});

test("bootstrap removes its request when the fixed deployment unit fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sentrybox-bootstrap-"));
  const requestPath = join(directory, "deploy-request.json");
  try {
    await assert.rejects(
      bootstrapFirstRelease({
        token: "test-token-held-only-in-memory",
        currentMainSha: SHA,
        requestPath,
        fetchImpl: async () => response({ workflow_runs: [workflowRun()] }),
        startDeploy: async () => {
          throw new Error("fixed deploy failed");
        },
      }),
      /fixed deploy failed/u,
    );
    assert.equal(existsSync(requestPath), false);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("bootstrap credential accepts only root:root 0400 or 0600 regular single-link files", () => {
  for (const mode of [0o100400, 0o100600]) {
    let reads = 0;
    const token = readBootstrapToken("/credential", {
      lstat: () => metadata({ mode }),
      readFile: () => {
        reads += 1;
        return "credential-value\n";
      },
    });
    assert.equal(token, "credential-value");
    assert.equal(reads, 1);
  }
});

test("bootstrap credential metadata is checked before token content is read", () => {
  const unsafe = [
    ["symlink", metadata({ isFile: () => false })],
    ["non-root owner", metadata({ uid: 1000 })],
    ["non-root group", metadata({ gid: 1000 })],
    ["owner executable", metadata({ mode: 0o100500 })],
    ["group readable", metadata({ mode: 0o100640 })],
    ["multiple links", metadata({ nlink: 2 })],
  ];
  for (const [name, fileMetadata] of unsafe) {
    let reads = 0;
    assert.throws(
      () =>
        readBootstrapToken("/credential", {
          readFile: () => {
            reads += 1;
            return "must-not-be-read";
          },
          lstat: () => fileMetadata,
        }),
      /root-owned, private, singly linked regular file/u,
      name,
    );
    assert.equal(reads, 0, name);
  }
});

test("bootstrap resolves current main with a zero-write canonical ls-remote lookup", () => {
  const calls = [];
  const sha = currentCanonicalMainSha((args) => {
    calls.push(args);
    if (args.join(" ") === "remote get-url origin") {
      return "https://github.com/pbuchman/sentrybox.git";
    }
    if (args.join(" ") === "ls-remote --exit-code origin refs/heads/main") {
      return `${SHA}\trefs/heads/main`;
    }
    assert.fail(`unexpected git arguments: ${args.join(" ")}`);
  });

  assert.equal(sha, SHA);
  assert.deepEqual(calls, [
    ["remote", "get-url", "origin"],
    ["ls-remote", "--exit-code", "origin", "refs/heads/main"],
  ]);
  assert.equal(calls.flat().includes("fetch"), false);
});

test("bootstrap rejects a non-canonical origin or ambiguous main lookup", () => {
  assert.throws(
    () => currentCanonicalMainSha(() => "https://github.com/attacker/repo.git"),
    /unexpected origin/u,
  );

  for (const output of [
    `${OTHER_SHA}\trefs/heads/other`,
    `${SHA}\trefs/heads/main\n${OTHER_SHA}\trefs/heads/main`,
    "not-a-sha\trefs/heads/main",
  ]) {
    assert.throws(
      () =>
        currentCanonicalMainSha((args) =>
          args[0] === "remote"
            ? "git@github.com:pbuchman/sentrybox.git"
            : output,
        ),
      /current origin\/main SHA is invalid/u,
    );
  }
});

test("bootstrap unit receives the token only as a credential and uses stable system Node", async () => {
  const unit = await readFile(
    new URL("./sentrybox-deploy-bootstrap.service", import.meta.url),
    "utf8",
  );

  assert.match(
    unit,
    /^ExecStart=\/opt\/nodejs\/current\/bin\/node --jitless deploy\/home-dev\/bootstrap-release\.mjs$/mu,
  );
  assert.match(
    unit,
    /^LoadCredential=github-bootstrap-token:\/home\/pbuchman\/services\/sentrybox\/deploy\/github-bootstrap-token$/mu,
  );
  assert.match(unit, /^ReadWritePaths=\/var\/lib\/sentrybox-deploy$/mu);
  assert.match(unit, /^InaccessiblePaths=\/var\/run\/docker\.sock$/mu);
  assert.doesNotMatch(
    unit,
    /github-bootstrap-token.*ExecStart|ExecStart.*github-bootstrap-token/u,
  );
});

function workflowRun() {
  return {
    name: "Release SentryBox Image",
    event: "push",
    head_branch: "main",
    head_sha: SHA,
    status: "completed",
    conclusion: "success",
    path: ".github/workflows/release-image.yml",
    workflow_id: 123456,
    repository: { full_name: "pbuchman/sentrybox" },
  };
}

function response(body) {
  return { ok: true, status: 200, json: async () => body };
}

function metadata(overrides = {}) {
  return {
    isFile: () => true,
    mode: 0o100600,
    uid: 0,
    gid: 0,
    nlink: 1,
    ...overrides,
  };
}

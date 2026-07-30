import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { constants, existsSync } from "node:fs";
import { mkdtemp, readFile, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  bootstrapFirstRelease,
  currentCanonicalMainSha,
  githubFetch,
  readBootstrapToken,
} from "./bootstrap-release.mjs";

const SHA = "1234567890abcdef1234567890abcdef12345678";
const OTHER_SHA = "abcdef1234567890abcdef1234567890abcdef12";
const WORKFLOW_RUNS_URL =
  "https://api.github.com/repos/pbuchman/sentrybox/actions/workflows/release-image.yml/runs?event=push&status=completed&per_page=100";
const BOOTSTRAP_TOKEN_FILE = "/var/lib/sentrybox-deploy/bootstrap-github-token";

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
        "User-Agent": "SentryBox-Home-Dev-bootstrap",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    assert.equal(existsSync(requestPath), false);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("bootstrap uses a bounded HTTPS client that keeps credentials out of the URL", async () => {
  const calls = [];
  const token = "test-token-held-only-in-memory";
  const requestImpl = (url, options, onResponse) => {
    calls.push({ url: String(url), options });
    const request = new EventEmitter();
    request.setTimeout = (milliseconds, onTimeout) => {
      calls.push({ timeout: milliseconds, onTimeout: typeof onTimeout });
    };
    request.destroy = (error) => request.emit("error", error);
    request.end = () => {
      queueMicrotask(() => {
        const response = new PassThrough();
        response.statusCode = 200;
        onResponse(response);
        response.end(JSON.stringify({ workflow_runs: [workflowRun()] }));
      });
    };
    return request;
  };

  const response = await githubFetch(
    WORKFLOW_RUNS_URL,
    {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
    requestImpl,
  );

  assert.equal(response.ok, true);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    workflow_runs: [workflowRun()],
  });
  assert.equal(calls[0].url, WORKFLOW_RUNS_URL);
  assert.equal(calls[0].url.includes(token), false);
  assert.equal(calls[0].options.method, "GET");
  assert.equal(calls[0].options.headers.Authorization, `Bearer ${token}`);
  assert.deepEqual(calls[1], { timeout: 10_000, onTimeout: "function" });
});

test("bootstrap HTTPS client rejects timeouts, oversized bodies, and invalid JSON", async () => {
  const headers = { "User-Agent": "SentryBox-test" };
  const timeoutRequest = (_url, _options, _onResponse) => {
    const request = new EventEmitter();
    let onTimeout;
    request.setTimeout = (_milliseconds, callback) => {
      onTimeout = callback;
    };
    request.destroy = (error) => request.emit("error", error);
    request.end = () => queueMicrotask(onTimeout);
    return request;
  };
  await assert.rejects(
    githubFetch(WORKFLOW_RUNS_URL, { headers }, timeoutRequest),
    /timed out/u,
  );

  const responseRequest = (body) => (_url, _options, onResponse) => {
    const request = new EventEmitter();
    request.setTimeout = () => {};
    request.destroy = (error) => request.emit("error", error);
    request.end = () => {
      queueMicrotask(() => {
        const response = new PassThrough();
        response.statusCode = 200;
        onResponse(response);
        response.end(body);
      });
    };
    return request;
  };
  await assert.rejects(
    githubFetch(
      WORKFLOW_RUNS_URL,
      { headers },
      responseRequest(Buffer.alloc(4 * 1024 * 1024 + 1)),
    ),
    /too large/u,
  );

  const malformed = await githubFetch(
    WORKFLOW_RUNS_URL,
    { headers },
    responseRequest("{"),
  );
  await assert.rejects(malformed.json(), SyntaxError);
});

test("bootstrap production networking avoids the global Fetch API under jitless", async () => {
  const source = await readFile(
    new URL("./bootstrap-release.mjs", import.meta.url),
    "utf8",
  );

  assert.doesNotMatch(source, /fetchImpl\s*=\s*fetch/u);
  assert.match(source, /require\("node:https"\)/u);
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

test("bootstrap validates the complete fixed root-owned source chain before reading", () => {
  const calls = [];
  let reads = 0;
  let closes = 0;
  const token = readBootstrapToken(BOOTSTRAP_TOKEN_FILE, {
    lstat: (path) => {
      calls.push(path);
      return safeBootstrapMetadata(path);
    },
    open: (path, flags) => {
      assert.equal(path, BOOTSTRAP_TOKEN_FILE);
      assert.notEqual(flags & constants.O_NOFOLLOW, 0);
      assert.notEqual(flags & constants.O_NONBLOCK, 0);
      return 42;
    },
    fstat: (descriptor) => {
      assert.equal(descriptor, 42);
      return fileMetadata();
    },
    readFile: (descriptor) => {
      assert.equal(descriptor, 42);
      reads += 1;
      return "credential-value\n";
    },
    close: (descriptor) => {
      assert.equal(descriptor, 42);
      closes += 1;
    },
  });

  assert.equal(token, "credential-value");
  assert.deepEqual(calls, [
    "/",
    "/var",
    "/var/lib",
    "/var/lib/sentrybox-deploy",
    BOOTSTRAP_TOKEN_FILE,
  ]);
  assert.equal(reads, 1);
  assert.equal(closes, 1);
});

test("unsafe bootstrap parents prevent content reads and GitHub requests", async () => {
  const unsafeParents = [
    ["root owner", "/var", directoryMetadata(0o40755, { uid: 1000 })],
    ["root group", "/var/lib", directoryMetadata(0o40755, { gid: 1000 })],
    ["private mode", "/var/lib/sentrybox-deploy", directoryMetadata(0o40755)],
    [
      "regular parent",
      "/var/lib/sentrybox-deploy",
      fileMetadata({ mode: 0o100700 }),
    ],
  ];

  for (const [name, unsafePath, unsafeMetadata] of unsafeParents) {
    let reads = 0;
    let requests = 0;
    await assert.rejects(
      Promise.resolve().then(() =>
        bootstrapFirstRelease({
          token: readBootstrapToken(BOOTSTRAP_TOKEN_FILE, {
            lstat: (path) =>
              path === unsafePath
                ? unsafeMetadata
                : safeBootstrapMetadata(path),
            readFile: () => {
              reads += 1;
              return "must-not-be-read";
            },
          }),
          currentMainSha: SHA,
          fetchImpl: async () => {
            requests += 1;
            return response({ workflow_runs: [workflowRun()] });
          },
        }),
      ),
      /root-owned bootstrap token source directory/u,
      name,
    );
    assert.equal(reads, 0, name);
    assert.equal(requests, 0, name);
  }
});

test("unsafe bootstrap files prevent content reads and GitHub requests", async () => {
  const unsafe = [
    ["symlink", fileMetadata({ isFile: () => false })],
    ["fifo", fileMetadata({ isFile: () => false, mode: 0o010600 })],
    ["device", fileMetadata({ isFile: () => false, mode: 0o020600 })],
    ["non-root owner", fileMetadata({ uid: 1000 })],
    ["non-root group", fileMetadata({ gid: 1000 })],
    ["read-only owner mode", fileMetadata({ mode: 0o100400 })],
    ["owner executable", fileMetadata({ mode: 0o100500 })],
    ["group readable", fileMetadata({ mode: 0o100640 })],
    ["multiple links", fileMetadata({ nlink: 2 })],
  ];
  for (const [name, fileMetadata] of unsafe) {
    let reads = 0;
    let requests = 0;
    await assert.rejects(
      Promise.resolve().then(() =>
        bootstrapFirstRelease({
          token: readBootstrapToken(BOOTSTRAP_TOKEN_FILE, {
            readFile: () => {
              reads += 1;
              return "must-not-be-read";
            },
            lstat: (path) =>
              path === BOOTSTRAP_TOKEN_FILE
                ? fileMetadata
                : safeBootstrapMetadata(path),
          }),
          currentMainSha: SHA,
          fetchImpl: async () => {
            requests += 1;
            return response({ workflow_runs: [workflowRun()] });
          },
        }),
      ),
      /root-owned, mode 0600, singly linked regular file/u,
      name,
    );
    assert.equal(reads, 0, name);
    assert.equal(requests, 0, name);
  }
});

test("bootstrap revalidates the opened source before reading it", () => {
  let reads = 0;
  let closes = 0;
  assert.throws(
    () =>
      readBootstrapToken(BOOTSTRAP_TOKEN_FILE, {
        lstat: safeBootstrapMetadata,
        open: () => 42,
        fstat: () => fileMetadata({ nlink: 2 }),
        readFile: () => {
          reads += 1;
          return "must-not-be-read";
        },
        close: () => {
          closes += 1;
        },
      }),
    /root-owned, mode 0600, singly linked regular file/u,
  );
  assert.equal(reads, 0);
  assert.equal(closes, 1);
});

test("successful bootstrap removes its one-time local token source", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sentrybox-bootstrap-"));
  const requestPath = join(directory, "deploy-request.json");
  let removals = 0;
  try {
    await bootstrapFirstRelease({
      token: "test-token-held-only-in-memory",
      currentMainSha: SHA,
      requestPath,
      fetchImpl: async () => response({ workflow_runs: [workflowRun()] }),
      startDeploy: async () => unlink(requestPath),
      removeBootstrapToken: () => {
        removals += 1;
      },
    });
    assert.equal(removals, 1);
  } finally {
    await rm(directory, { force: true, recursive: true });
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

test("bootstrap unit passes only the fixed root-controlled source path to stable system Node", async () => {
  const unit = await readFile(
    new URL("./sentrybox-deploy-bootstrap.service", import.meta.url),
    "utf8",
  );

  assert.match(
    unit,
    /^ExecStart=\/opt\/nodejs\/current\/bin\/node --jitless deploy\/home-dev\/bootstrap-release\.mjs$/mu,
  );
  assert.doesNotMatch(unit, /^LoadCredential=/mu);
  assert.match(unit, /\/var\/lib\/sentrybox-deploy\/bootstrap-github-token/u);
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

function fileMetadata(overrides = {}) {
  return {
    isFile: () => true,
    mode: 0o100600,
    uid: 0,
    gid: 0,
    nlink: 1,
    dev: 1,
    ino: 2,
    ...overrides,
  };
}

function directoryMetadata(mode, overrides = {}) {
  return {
    isDirectory: () => true,
    isFile: () => false,
    mode,
    uid: 0,
    gid: 0,
    ...overrides,
  };
}

function safeBootstrapMetadata(path) {
  switch (path) {
    case "/":
    case "/var":
    case "/var/lib":
      return directoryMetadata(0o40755);
    case "/var/lib/sentrybox-deploy":
      return directoryMetadata(0o40700);
    case BOOTSTRAP_TOKEN_FILE:
      return fileMetadata();
    default:
      throw new Error(`unexpected metadata path: ${path}`);
  }
}

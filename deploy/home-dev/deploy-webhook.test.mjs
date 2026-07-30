import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHmac } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createDeployWebhookServer,
  DeliveryStore,
  MAX_BODY_BYTES,
  validateWorkflowRun,
  verifyGitHubSignature,
} from "./deploy-webhook.mjs";

const NOW = new Date("2026-07-29T05:00:00.000Z");
const SECRET = "fixture-deploy-webhook-secret-with-32-bytes";
const SHA = "1234567890abcdef1234567890abcdef12345678";

test("verifies sha256 over exact raw bytes and rejects malformed signatures", () => {
  const body = Buffer.from('{"fixture":true}');
  const signature = sign(body);

  assert.equal(verifyGitHubSignature(body, signature, SECRET), true);
  assert.equal(
    verifyGitHubSignature(Buffer.from('{"fixture":false}'), signature, SECRET),
    false,
  );
  for (const invalid of [
    undefined,
    "",
    "sha1=0000",
    "sha256=0000",
    `sha256=${"z".repeat(64)}`,
    `sha256=${"0".repeat(66)}`,
  ]) {
    assert.equal(verifyGitHubSignature(body, invalid, SECRET), false);
  }
});

test("accepts only the exact successful main push release workflow", () => {
  assert.deepEqual(validateWorkflowRun(validPayload(), NOW), {
    headSha: SHA,
    updatedAt: "2026-07-29T04:59:00.000Z",
  });

  for (const [name, mutate] of [
    [
      "repository",
      (payload) => (payload.repository.full_name = "attacker/repo"),
    ],
    ["action", (payload) => (payload.action = "requested")],
    ["workflow", (payload) => (payload.workflow_run.name = "CI")],
    ["event", (payload) => (payload.workflow_run.event = "pull_request")],
    ["branch", (payload) => (payload.workflow_run.head_branch = "feature")],
    ["conclusion", (payload) => (payload.workflow_run.conclusion = "failure")],
    ["sha", (payload) => (payload.workflow_run.head_sha = "main")],
    [
      "stale timestamp",
      (payload) =>
        (payload.workflow_run.updated_at = "2026-07-29T04:54:59.999Z"),
    ],
    [
      "future timestamp",
      (payload) =>
        (payload.workflow_run.updated_at = "2026-07-29T05:00:31.000Z"),
    ],
  ]) {
    const payload = validPayload();
    mutate(payload);
    assert.throws(
      () => validateWorkflowRun(payload, NOW),
      new RegExp(name.replace(" timestamp", ""), "u"),
    );
  }
});

test("delivery IDs persist before invocation, expire after seven days, and reject replay", () => {
  const directory = mkdtempSync(join(tmpdir(), "error-hub-deliveries-"));
  const path = join(directory, "deliveries.json");
  try {
    const store = new DeliveryStore(path, () => NOW);
    assert.equal(store.has("delivery-1"), false);
    store.record("delivery-1", SHA);
    assert.equal(store.has("delivery-1"), true);

    const reopened = new DeliveryStore(
      path,
      () => new Date("2026-08-05T04:59:59.999Z"),
    );
    assert.equal(reopened.has("delivery-1"), true);
    assert.throws(() => reopened.record("delivery-1", SHA), /replay/u);

    const expired = new DeliveryStore(
      path,
      () => new Date("2026-08-05T05:00:00.001Z"),
    );
    assert.equal(expired.has("delivery-1"), false);
    expired.record("delivery-2", SHA);
    const contents = readFileSync(path, "utf8");
    assert.doesNotMatch(contents, /delivery-1/u);
    assert.match(contents, /delivery-2/u);
    assert.equal(contents.includes(SECRET), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("HTTP boundary rejects path, method, event, signature, stale payload, and oversized body", async () => {
  const fixture = await serverFixture();
  try {
    const cases = [
      request("GET", "/github/workflow-run", validPayload(), "workflow_run"),
      request("POST", "/health", validPayload(), "workflow_run"),
      request("POST", "/github/workflow-run", validPayload(), "push"),
      request("POST", "/github/workflow-run", validPayload(), "workflow_run", {
        signature: null,
      }),
      request("POST", "/github/workflow-run", validPayload(), "workflow_run", {
        signature: "sha256=" + "0".repeat(64),
      }),
      request("POST", "/github/workflow-run", stalePayload(), "workflow_run"),
    ];
    const expected = [404, 404, 400, 401, 401, 400];
    for (let index = 0; index < cases.length; index += 1) {
      const response = await fetch(
        fixture.url + cases[index].path,
        cases[index].init,
      );
      assert.equal(response.status, expected[index]);
    }

    const oversized = Buffer.alloc(MAX_BODY_BYTES + 1, 65);
    const response = await fetch(fixture.url + "/github/workflow-run", {
      method: "POST",
      headers: signedHeaders(oversized, "oversized-delivery", "workflow_run"),
      body: oversized,
    });
    assert.equal(response.status, 413);
    assert.deepEqual(fixture.invocations, []);
  } finally {
    await fixture.close();
  }
});

test("production wiring invokes only the fixed deployment unit from an isolated Home Dev checkout", () => {
  const source = readFileSync(
    new URL("./deploy-webhook.mjs", import.meta.url),
    "utf8",
  );
  const unitUrl = new URL(
    "./sentrybox-deploy-webhook.service",
    import.meta.url,
  );
  assert.equal(
    existsSync(unitUrl),
    true,
    "SentryBox deployment unit is missing: deploy/home-dev/sentrybox-deploy-webhook.service",
  );
  const unit = readFileSync(unitUrl, "utf8");
  const cloudflaredUnit = readFileSync(
    new URL("./cloudflared.service", import.meta.url),
    "utf8",
  );
  assert.match(source, /spawn\(\s*"\/usr\/bin\/systemctl"/u);
  assert.match(source, /import \{ spawn \} from "node:child_process"/u);
  assert.match(source, /\["--wait", "start", DEPLOY_UNIT\]/u);
  assert.match(source, /shell:\s*false/u);
  assert.match(source, /"Release SentryBox Image"/u);
  assert.match(source, /"pbuchman\/sentrybox"/u);
  assert.match(
    source,
    /"\/run\/credentials\/sentrybox-deploy-webhook\.service\/github-webhook-secret"/u,
  );
  assert.match(source, /"\/var\/lib\/sentrybox-deploy\/deliveries\.json"/u);
  assert.match(source, /"\/var\/lib\/sentrybox-deploy\/deploy-request\.json"/u);
  assert.match(source, /"sentrybox-deploy\.service"/u);
  assert.match(
    unit,
    /^LoadCredential=github-webhook-secret:\/home\/pbuchman\/services\/sentrybox\/deploy\/github-webhook-secret$/mu,
  );
  assert.match(unit, /^CapabilityBoundingSet=$/mu);
  assert.match(unit, /^NoNewPrivileges=true$/mu);
  assert.match(
    unit,
    /^ConditionPathExists=\/home\/pbuchman\/deploy\/sentrybox\/deploy\/home-dev\/deploy-webhook\.mjs$/mu,
  );
  assert.match(
    unit,
    /^WorkingDirectory=\/home\/pbuchman\/deploy\/sentrybox$/mu,
  );
  assert.match(
    unit,
    /^ExecStart=\/opt\/nodejs\/current\/bin\/node --jitless deploy\/home-dev\/deploy-webhook\.mjs$/mu,
  );
  assert.match(unit, /^ReadWritePaths=\/var\/lib\/sentrybox-deploy$/mu);
  assert.match(unit, /^ProtectHome=tmpfs$/mu);
  assert.match(
    unit,
    /^BindReadOnlyPaths=\/home\/pbuchman\/deploy\/sentrybox$/mu,
  );
  assert.doesNotMatch(unit, /^Bind(?:ReadOnly)?Paths=.*\/services\//mu);
  assert.deepEqual(unit.match(/^InaccessiblePaths=.*$/gmu), [
    "InaccessiblePaths=",
    "InaccessiblePaths=/var/run/docker.sock",
  ]);
  assert.match(unit, /^MemoryMax=128M$/mu);
  assert.match(unit, /^MemoryDenyWriteExecute=true$/mu);
  assert.match(
    unit,
    /^SystemCallFilter=@system-service pkey_alloc pkey_free pkey_mprotect$/mu,
  );
  assert.match(
    cloudflaredUnit,
    /--token-file \/run\/credentials\/cloudflared\.service\/tunnel-token/u,
  );
  assert.match(
    cloudflaredUnit,
    /^LoadCredential=tunnel-token:\/home\/pbuchman\/services\/sentrybox\/deploy\/cloudflare-tunnel-token$/mu,
  );
  assert.doesNotMatch(cloudflaredUnit, /(?:^|\s)--token(?:\s|=)(?!-file)/u);
});

test("one valid delivery invokes the fixed deploy callback once and a redelivery is rejected", async () => {
  const fixture = await serverFixture();
  try {
    const first = request(
      "POST",
      "/github/workflow-run",
      validPayload(),
      "workflow_run",
    );
    const response = await fetch(fixture.url + first.path, first.init);
    assert.equal(response.status, 202);
    await fixture.deploymentSettled();
    assert.deepEqual(fixture.invocations, [SHA]);

    const replay = await fetch(fixture.url + first.path, first.init);
    assert.equal(replay.status, 409);
    assert.deepEqual(fixture.invocations, [SHA]);
  } finally {
    await fixture.close();
  }
});

test("a deployment in progress holds the concurrency lock without consuming another delivery", async () => {
  let release;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  const fixture = await serverFixture({ invokeDeploy: () => blocked });
  try {
    const first = request(
      "POST",
      "/github/workflow-run",
      validPayload(),
      "workflow_run",
      { delivery: "delivery-first" },
    );
    assert.equal(
      (await fetch(fixture.url + first.path, first.init)).status,
      202,
    );

    const secondPayload = validPayload();
    secondPayload.workflow_run.head_sha =
      "abcdef1234567890abcdef1234567890abcdef12";
    const second = request(
      "POST",
      "/github/workflow-run",
      secondPayload,
      "workflow_run",
      { delivery: "delivery-second" },
    );
    assert.equal(
      (await fetch(fixture.url + second.path, second.init)).status,
      409,
    );
    assert.equal(fixture.store.has("delivery-second"), false);
  } finally {
    release();
    await fixture.deploymentSettled();
    await fixture.close();
  }
});

function validPayload() {
  return {
    action: "completed",
    repository: { full_name: "pbuchman/sentrybox" },
    workflow_run: {
      name: "Release SentryBox Image",
      event: "push",
      head_branch: "main",
      head_sha: SHA,
      conclusion: "success",
      updated_at: "2026-07-29T04:59:00.000Z",
    },
  };
}

function stalePayload() {
  const payload = validPayload();
  payload.workflow_run.updated_at = "2026-07-29T04:00:00.000Z";
  return payload;
}

function sign(body) {
  return `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;
}

function signedHeaders(body, delivery, event) {
  return {
    "content-type": "application/json",
    "x-github-delivery": delivery,
    "x-github-event": event,
    "x-hub-signature-256": sign(body),
  };
}

function request(method, path, payload, event, overrides = {}) {
  const body = Buffer.from(JSON.stringify(payload));
  const headers = signedHeaders(
    body,
    overrides.delivery ?? "fixture-delivery",
    event,
  );
  if (overrides.signature === null) {
    delete headers["x-hub-signature-256"];
  } else if (overrides.signature !== undefined) {
    headers["x-hub-signature-256"] = overrides.signature;
  }
  return {
    path,
    init: {
      method,
      headers,
      ...(method === "GET" ? {} : { body }),
    },
  };
}

async function serverFixture(options = {}) {
  const directory = mkdtempSync(join(tmpdir(), "error-hub-webhook-"));
  const store = new DeliveryStore(
    join(directory, "deliveries.json"),
    () => NOW,
  );
  const invocations = [];
  let deployment = Promise.resolve();
  const server = createDeployWebhookServer({
    secret: SECRET,
    deliveryStore: store,
    now: () => NOW,
    invokeDeploy: (sha) => {
      invocations.push(sha);
      deployment = Promise.resolve(options.invokeDeploy?.(sha));
      return deployment;
    },
    log: () => {},
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  return {
    url: `http://127.0.0.1:${String(address.port)}`,
    invocations,
    store,
    deploymentSettled: () => deployment,
    async close() {
      await new Promise((resolve, reject) =>
        server.close((error) =>
          error === undefined ? resolve() : reject(error),
        ),
      );
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const read = (name) => readFileSync(new URL(name, import.meta.url), "utf8");

test("privileged units resolve reviewed control through the protected selector", () => {
  for (const name of [
    "sentrybox.service",
    "sentrybox-deploy.service",
    "sentrybox-deploy-bootstrap.service",
    "sentrybox-backup.service",
    "sentrybox-monitor.service",
    "sentrybox-restore-test.service",
  ]) {
    const unit = read(name);
    assert.match(
      unit,
      /WorkingDirectory=\/opt\/sentrybox-control\/current\/deploy\/home-dev/u,
    );
    assert.doesNotMatch(unit, /\/(home\/pbuchman|deploy\/sentrybox)/u);
  }
});

test("webhook invokes only a scoped Unix socket as its own system user", () => {
  const unit = read("sentrybox-deploy-webhook.service");
  assert.match(unit, /^User=sentrybox-webhook$/mu);
  assert.match(unit, /^StateDirectory=sentrybox-deploy-webhook$/mu);
  assert.match(
    unit,
    /^InaccessiblePaths=\/var\/run\/docker\.sock \/run\/dbus\/system_bus_socket$/mu,
  );
  const socket = read("sentrybox-deploy-request.socket");
  assert.match(socket, /^SocketGroup=sentrybox-webhook$/mu);
  assert.match(socket, /^SocketMode=0660$/mu);
  assert.match(socket, /^Accept=yes$/mu);
  assert.match(
    read("deploy-webhook.mjs"),
    /\/run\/sentrybox-deploy-request\.sock/u,
  );
});

test("Compose uses protected bind parents and explicitly disables implicit dotenv", () => {
  const compose = read("compose.yaml");
  assert.match(compose, /\/var\/lib\/sentrybox\/data/u);
  assert.match(compose, /\/var\/lib\/sentrybox\/env/u);
  assert.equal([...compose.matchAll(/create_host_path: false/gu)].length, 3);
  assert.doesNotMatch(compose, /\/home\/pbuchman/u);
  assert.match(read("common.sh"), /--env-file \/dev\/null/u);
});

test("the privileged socket reader accepts one framed SHA", () => {
  const helper = fileURLToPath(new URL("./deploy-request.py", import.meta.url));
  const result = spawnSync(
    "/usr/bin/python3",
    [
      "-I",
      "-c",
      `
import runpy
from contextlib import ExitStack
import socket
import sys

read_sha = runpy.run_path(sys.argv[1])["read_sha"]
expected = b"a" * 40
for payload, accepted in [
    (expected + b"\\n", True),
    (expected, False),
    (expected + b"\\n" + b"extra", False),
    (b"", False),
]:
    with ExitStack() as stack:
        source, target = socket.socketpair()
        stack.enter_context(source)
        stack.enter_context(target)
        source.sendall(payload)
        source.shutdown(socket.SHUT_WR)
        try:
            assert read_sha(target) == expected.decode("ascii")
        except ValueError:
            assert not accepted
        else:
            assert accepted
`,
      helper,
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
});

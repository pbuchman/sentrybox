import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);

async function source(path) {
  return readFile(new URL(path, root), "utf8");
}

test("the image uses a pinned Node 22 builder and numeric non-root runtime", async () => {
  const dockerfile = await source("Dockerfile");

  assert.match(
    dockerfile,
    /node:22\.23\.1-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3/u,
  );
  assert.match(dockerfile, /\bAS builder\b/u);
  assert.match(dockerfile, /\bAS runtime\b/u);
  assert.match(dockerfile, /^USER [1-9]\d*:[1-9]\d*$/mu);
  assert.match(dockerfile, /^EXPOSE 8080 8081$/mu);
  assert.match(dockerfile, /CMD \["node",\s*"dist\/src\/main\.js"\]/u);
  assert.match(
    dockerfile,
    /COPY --from=builder \/etc\/ssl\/certs\/ca-certificates\.crt \/etc\/ssl\/certs\/ca-certificates\.crt/u,
  );
  assert.match(dockerfile, /scripts\/admin\/generate-project-config\.mjs/u);
  assert.match(dockerfile, /scripts\/admin\/validate-project-config\.mjs/u);

  const patchCopy = dockerfile.indexOf(
    "COPY patches/brace-expansion@5.0.8.patch patches/brace-expansion@5.0.8.patch",
  );
  const frozenInstall = dockerfile.indexOf(
    "RUN pnpm install --frozen-lockfile",
  );
  assert.ok(
    patchCopy >= 0,
    "the patched dependency must be copied into the build context",
  );
  assert.ok(
    patchCopy < frozenInstall,
    "the patched dependency must be copied before the frozen install",
  );
  assert.ok(
    dockerfile.indexOf("COPY apps apps") < frozenInstall,
    "workspace sources must be copied before install so Docker cannot replace package node_modules links",
  );
  assert.ok(
    dockerfile.indexOf("COPY packages packages") < frozenInstall,
    "workspace packages must be copied before install so Docker cannot replace package node_modules links",
  );

  const runtime = dockerfile.split(/\bAS runtime\b/u)[1] ?? "";
  assert.doesNotMatch(runtime, /\b(?:apt|apt-get|apk|dnf|yum)\b/u);
  assert.doesNotMatch(runtime, /\bpnpm\s+(?:install|add)\b/u);
  assert.match(runtime, /\/usr\/local\/lib\/node_modules\/(?:npm|corepack)/u);
  assert.match(runtime, /\/opt\/yarn-v1\.22\.22/u);
});

test("compose keeps both listeners on host loopback and hardens the container", async () => {
  const compose = await source("deploy/home-dev/compose.yaml");

  assert.match(compose, /^services:\s*\n\s{2}sentrybox:\s*$/mu);
  assert.doesNotMatch(compose, /^\s{2}error-hub:\s*$/mu);
  assert.match(
    compose,
    /image:\s*\$\{ERROR_HUB_IMAGE:\?immutable image digest required\}/u,
  );
  assert.match(compose, /"127\.0\.0\.1:8140:8080"/u);
  assert.match(compose, /"127\.0\.0\.1:8141:8081"/u);
  assert.match(compose, /ERROR_HUB_PUBLIC_HOST:\s*"0\.0\.0\.0"/u);
  assert.match(compose, /ERROR_HUB_PRIVATE_HOST:\s*"0\.0\.0\.0"/u);
  assert.match(
    compose,
    /env_file:\s*\n\s*-\s*"?\$\{ERROR_HUB_RUNTIME_ENV_FILE:-\/var\/lib\/sentrybox-deploy\/runtime\.env\}"?/u,
  );
  assert.doesNotMatch(compose, /^\s+ERROR_HUB_REQUIRED_SECRET_REFERENCES:/mu);
  assert.match(compose, /read_only:\s*true/u);
  assert.match(compose, /\/tmp:size=64m,mode=1777/u);
  assert.match(compose, /cap_drop:\s*\n\s*- ALL/u);
  assert.match(compose, /no-new-privileges:true/u);
  assert.match(compose, /pids_limit:\s*[1-9]\d*/u);
  assert.match(compose, /mem_limit:\s*[1-9]\d*[mMgG]/u);
  assert.match(compose, /restart:\s*unless-stopped/u);
  assert.match(compose, /\/health\/ready/u);
  assert.match(compose, /max-size:\s*"?10m"?/u);
  assert.match(compose, /max-file:\s*"?3"?/u);
  assert.match(compose, /\/home\/pbuchman\/services\/sentrybox\/data:\/data/u);
  assert.match(
    compose,
    /\/home\/pbuchman\/services\/sentrybox\/env:\/run\/secrets\/sentrybox-env:ro/u,
  );
  assert.match(
    compose,
    /\/home\/pbuchman\/deploy\/sentrybox\/deploy\/home-dev\/config\.example\.json:\/run\/config\/sentrybox-projects\.json:ro/u,
  );
  assert.doesNotMatch(compose, /^volumes:\s*$/mu);
  assert.doesNotMatch(compose, /\bdown\s+-v\b/u);
  assert.doesNotMatch(compose, /(?:^|[:@])latest(?:$|\s)/mu);
});

test("operator commands load deployment state explicitly", async () => {
  const runbook = await source("docs/runbooks/project-configuration.md");
  const composeCommands =
    runbook.match(/sudo docker compose[\s\S]*?(?=\n```)/gu) ?? [];

  assert.ok(composeCommands.length >= 6);
  for (const command of composeCommands) {
    assert.match(
      command,
      /sudo docker compose --env-file \/var\/lib\/sentrybox-deploy\/current\.env/u,
    );
  }
  assert.doesNotMatch(runbook, /\/run\/config\/error-hub-projects\.json/u);
  assert.equal(
    Array.from(
      runbook.matchAll(/--config \/run\/config\/sentrybox-projects\.json/gu),
    ).length,
    6,
  );
  const disableSection =
    runbook
      .split("## Disable Code Agent delivery")[1]
      ?.split("## Disable legacy Sentry shadow forwarding")[0] ?? "";
  assert.match(disableSection, /\/home\/pbuchman\/services\/sentrybox\/env/u);
  assert.match(disableSection, /\/var\/lib\/sentrybox-deploy\/runtime\.env/u);
  assert.match(disableSection, /remove[^.]*HMAC[^.]*name/iu);
});

test("verification is bounded and never installs packages at runtime", async () => {
  const verifier = await source("deploy/home-dev/verify-container.sh");

  assert.match(verifier, /^#!\/usr\/bin\/env bash$/mu);
  assert.match(verifier, /docker compose/u);
  assert.match(verifier, /health\/live/u);
  assert.match(verifier, /health\/ready/u);
  assert.match(verifier, /--max-time/u);
  assert.match(verifier, /verify_container="sentrybox-verify-\$\$"/u);
  assert.match(verifier, /verify\.sentrybox\.invalid:8443/u);
  assert.match(verifier, /mktemp -d \/tmp\/sentrybox-container\.XXXXXX/u);
  assert.match(verifier, /\/tmp\/sentrybox-write-test/u);
  assert.match(verifier, /dst=\/run\/secrets\/sentrybox-env/u);
  assert.match(verifier, /dst=\/run\/config\/sentrybox-projects\.json/u);
  assert.match(verifier, /\/etc\/ssl\/certs\/ca-certificates\.crt/u);
  assert.match(verifier, /docker inspect/u);
  assert.match(verifier, /docker stop/u);
  assert.match(
    verifier,
    /Runtime image contains workspace source or test artifacts/u,
  );
  assert.match(verifier, /Runtime image contains an unused package manager/u);
  assert.doesNotMatch(verifier, /\b(?:apt|apt-get|apk|dnf|yum)\b/u);
  assert.doesNotMatch(verifier, /\bdown\s+-v\b/u);
});

test("active runtime artifacts do not expose the retired product name", async () => {
  const runtimeArtifacts = [
    "Dockerfile",
    "apps/server/src/api/exports.ts",
    "apps/server/src/ingest/project-auth.ts",
    "apps/server/src/ingest/route.ts",
    "apps/server/src/main.ts",
    "apps/server/src/metrics.ts",
    "apps/server/src/runtime.ts",
    "apps/server/src/static-ui.ts",
    "apps/server/src/storage/database.ts",
    "apps/web/src/main.tsx",
    "deploy/home-dev/backup.sh",
    "deploy/home-dev/common.sh",
    "deploy/home-dev/compose.yaml",
    "deploy/home-dev/database-operations.mjs",
    "deploy/home-dev/deploy.sh",
    "deploy/home-dev/preflight.sh",
    "deploy/home-dev/rollback.sh",
    "deploy/home-dev/verify-container.sh",
    "packages/protocol/src/normalize.ts",
    "scripts/admin/generate-project-config.mjs",
  ];

  for (const path of runtimeArtifacts) {
    const contents = (await source(path)).replaceAll("error-hub.sqlite", "");
    assert.doesNotMatch(
      contents,
      /Error Hub|error-hub/iu,
      `${path} contains an active retired product identifier`,
    );
    if (path === "apps/server/src/metrics.ts") {
      assert.doesNotMatch(
        contents,
        /error_hub/iu,
        `${path} exposes the retired Prometheus namespace`,
      );
    }
  }
});

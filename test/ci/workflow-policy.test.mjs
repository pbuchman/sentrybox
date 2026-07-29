import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const workflowsDirectory = new URL(".github/workflows/", root);

async function source(path) {
  return readFile(new URL(path, root), "utf8");
}

function jobBlocks(workflow) {
  const lines = workflow.split("\n");
  const jobsIndex = lines.findIndex((line) => line === "jobs:");
  assert.notEqual(jobsIndex, -1, "workflow has no jobs mapping");

  const blocks = [];
  let current = null;
  for (const line of lines.slice(jobsIndex + 1)) {
    if (/^\S/u.test(line)) break;

    const job = /^  ([a-zA-Z0-9_-]+):\s*$/u.exec(line);
    if (job !== null) {
      if (current !== null) blocks.push(current);
      current = { name: job[1], lines: [line] };
    } else if (current !== null) {
      current.lines.push(line);
    }
  }
  if (current !== null) blocks.push(current);
  return blocks.map(({ name, lines: blockLines }) => ({
    name,
    source: blockLines.join("\n"),
  }));
}

test("every workflow job is GitHub-hosted and PR payloads cannot control commands", async () => {
  const names = (await readdir(workflowsDirectory)).filter((name) =>
    /\.ya?ml$/u.test(name),
  );
  assert.ok(names.length >= 2, "CI and release workflows are required");

  for (const name of names) {
    const workflow = await source(`.github/workflows/${name}`);
    assert.doesNotMatch(
      workflow,
      /\bself-hosted\b/u,
      `${name} uses self-hosted`,
    );
    assert.doesNotMatch(
      workflow,
      /\b(?:pull_request_target|issue_comment|repository_dispatch)\s*:/u,
      `${name} accepts a privileged, payload-driven trigger`,
    );
    assert.doesNotMatch(
      workflow,
      /\$\{\{\s*(?:github\.event|github\.head_ref)\b/u,
      `${name} interpolates pull-request payload data`,
    );

    for (const job of jobBlocks(workflow)) {
      assert.match(
        job.source,
        /^    runs-on:\s*ubuntu-latest\s*$/mu,
        `${name}:${job.name} is not pinned to a GitHub-hosted runner label`,
      );
    }
  }
});

test("every external action is pinned to a full commit SHA", async () => {
  const names = (await readdir(workflowsDirectory)).filter((name) =>
    /\.ya?ml$/u.test(name),
  );

  for (const name of names) {
    const workflow = await source(`.github/workflows/${name}`);
    const references = Array.from(
      workflow.matchAll(/^\s+(?:-\s+)?uses:\s*([^\s#]+)/gmu),
      (match) => match[1],
    );
    assert.ok(references.length > 0, `${name} has no action references`);
    for (const reference of references) {
      assert.match(
        reference,
        /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+@[0-9a-f]{40}$/u,
        `${name} contains an unpinned action: ${reference}`,
      );
    }
  }
});

test("pull-request CI is read-only and exercises every required gate", async () => {
  const workflow = await source(".github/workflows/ci.yml");

  assert.match(workflow, /^name:\s*CI$/mu);
  assert.match(workflow, /^\s{2}pull_request:\s*$/mu);
  assert.match(workflow, /^permissions:\s*\n\s{2}contents:\s*read$/mu);
  assert.doesNotMatch(workflow, /^\s+packages:\s*write$/mu);
  assert.doesNotMatch(workflow, /\bpush:\s*true\b/u);
  assert.doesNotMatch(workflow, /docker\/login-action/u);
  assert.doesNotMatch(workflow, /\bsecrets\./u);

  for (const required of [
    "pnpm format:check",
    "pnpm lint",
    "pnpm typecheck",
    "pnpm build",
    "pnpm test",
    "pnpm test:integration",
    "playwright install --with-deps chromium",
    "pnpm licenses list --prod --json",
    "pnpm audit --audit-level=high",
    "scan-type: fs",
    "scanners: secret",
    "docker/build-push-action",
    "bats/bats:1.12.0@sha256:0257e4f5326dd37046e94d4b8ce07c293447be80a9db6d6dfff1d50d07617e2e",
    "node --test deploy/home-dev/database-operations.test.mjs",
    "shellcheck deploy/home-dev/*.sh",
  ]) {
    assert.ok(workflow.includes(required), `CI is missing ${required}`);
  }
});

test("CI executes the Home Dev network contract with pinned Caddy", async () => {
  const workflow = await source(".github/workflows/ci.yml");
  const routeVerifier = await source(
    "deploy/home-dev/test/verify-caddy-routes.sh",
  );

  assert.ok(
    workflow.includes("sudo apt-get install --yes bats shellcheck"),
    "CI does not install the network contract tools",
  );
  assert.ok(
    workflow.includes("shellcheck deploy/home-dev/configure-tailscale.sh"),
    "CI does not shellcheck the Tailscale setup",
  );
  assert.ok(
    workflow.includes("bats deploy/home-dev/test/network-contract.bats"),
    "CI does not execute the Bats network contract",
  );
  assert.match(
    routeVerifier,
    /caddy:2\.10\.2-alpine@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d/u,
  );
  assert.match(routeVerifier, /caddy validate/u);
  assert.doesNotMatch(routeVerifier, /caddy:latest/u);
});

test("CI and release isolate Alpine deploy tests and run network contracts on the host", async () => {
  for (const path of [
    ".github/workflows/ci.yml",
    ".github/workflows/release-image.yml",
  ]) {
    const workflow = await source(path);
    assert.match(workflow, /sudo apt-get install --yes bats shellcheck/u);
    assert.match(
      workflow,
      /shellcheck deploy\/home-dev\/configure-tailscale\.sh/u,
    );
    assert.match(
      workflow,
      /bats deploy\/home-dev\/test\/network-contract\.bats/u,
    );
    assert.match(
      workflow,
      /shellcheck deploy\/home-dev\/configure-tailscale\.sh deploy\/home-dev\/verify-container\.sh deploy\/home-dev\/test\/verify-caddy-routes\.sh deploy\/home-dev\/test\/read-http-request\.sh/u,
    );
    assert.match(
      workflow,
      /-c 'apk add --no-cache jq >\/dev\/null && bats deploy\/home-dev\/test\/deploy\.bats deploy\/home-dev\/test\/backup-retention\.bats'/u,
    );
    assert.doesNotMatch(
      workflow,
      /\bbats deploy\/home-dev\/test(?=$|['"\s])/mu,
      `${path} executes the complete Bats directory inside Alpine`,
    );
  }
});

test("main-only release publishes one immutable SentryBox amd64 tag with attestations", async () => {
  const workflow = await source(".github/workflows/release-image.yml");

  assert.match(workflow, /^name:\s*Release SentryBox Image$/mu);
  assert.match(workflow, /^\s{2}push:\s*$/mu);
  assert.match(workflow, /^\s{4}branches:\s*\[main\]\s*$/mu);
  assert.doesNotMatch(workflow, /^\s{2}pull_request:\s*$/mu);
  assert.doesNotMatch(workflow, /\bworkflow_dispatch\b/u);
  assert.doesNotMatch(workflow, /(?:^|[:@])latest(?:$|\s)/mu);

  const packageFilters = Array.from(
    workflow.matchAll(/\bpnpm --filter (\S+)/gu),
    (match) => match[1],
  );
  assert.deepEqual(packageFilters, ["@sentrybox/web", "@sentrybox/web"]);
  assert.deepEqual(
    Array.from(
      workflow.matchAll(/org\.opencontainers\.image\.source=(\S+)/gu),
      (match) => match[1],
    ),
    [
      "https://github.com/pbuchman/sentrybox",
      "https://github.com/pbuchman/sentrybox",
    ],
  );
  assert.deepEqual(
    Array.from(
      workflow.matchAll(/scope=repository:([^"&\s]+)/gu),
      (match) => match[1],
    ),
    ["pbuchman/sentrybox:pull"],
  );
  assert.deepEqual(
    Array.from(
      workflow.matchAll(
        /https:\/\/ghcr\.io\/v2\/([^"\s]+\/manifests\/sha-\$GITHUB_SHA)/gu,
      ),
      (match) => match[1],
    ),
    ["pbuchman/sentrybox/manifests/sha-$GITHUB_SHA"],
  );

  const release = jobBlocks(workflow).find((job) => job.name === "release");
  assert.ok(release, "release job is missing");
  assert.match(release.source, /^    needs:\s*verify$/mu);
  assert.match(release.source, /^      contents:\s*read$/mu);
  assert.match(release.source, /^      packages:\s*write$/mu);
  assert.equal(
    Array.from(
      release.source.matchAll(/^\s+([a-z-]+):\s*write$/gmu),
      (match) => match[1],
    ).join(","),
    "packages",
  );
  assert.match(
    workflow,
    /ghcr\.io\/pbuchman\/sentrybox:sha-\$\{\{\s*github\.sha\s*\}\}/u,
  );
  assert.match(workflow, /platforms:\s*linux\/amd64/u);
  assert.match(workflow, /push:\s*true/u);
  assert.match(workflow, /sbom:\s*true/u);
  assert.match(workflow, /provenance:\s*mode=max/u);
  assert.match(workflow, /Refuse to overwrite an existing commit tag/u);
  assert.match(
    workflow,
    /--request GET[\s\S]*?manifests\/sha-\$GITHUB_SHA/u,
    "GHCR manifest existence checks must consume the response body; HEAD can fail with curl error 18",
  );
  assert.doesNotMatch(workflow, /--request HEAD/u);
  for (const mediaType of [
    "application/vnd.oci.image.index.v1+json",
    "application/vnd.oci.image.manifest.v1+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
    "application/vnd.docker.distribution.manifest.v2+json",
  ]) {
    assert.ok(
      workflow.includes(mediaType),
      `GHCR existence check is missing ${mediaType}`,
    );
  }
  assert.match(
    workflow,
    /manifests\/sha-\$GITHUB_SHA[\s\S]*?404\)[\s\S]*?200\)/u,
  );
  assert.match(workflow, /steps\.publish\.outputs\.digest/u);
  assert.match(workflow, /GITHUB_STEP_SUMMARY/u);
});

test("image reference validator accepts only the repository SHA tag and digest", async () => {
  const script = fileURLToPath(
    new URL("scripts/ci/verify-image-ref.mjs", root),
  );
  const sha = "0123456789abcdef0123456789abcdef01234567";
  const digest = `sha256:${"a".repeat(64)}`;
  const valid = `ghcr.io/pbuchman/sentrybox:sha-${sha}`;

  assert.equal(spawnSync(process.execPath, [script, valid, sha]).status, 0);
  assert.equal(
    spawnSync(process.execPath, [script, valid, sha, digest]).status,
    0,
  );

  for (const args of [
    ["ghcr.io/pbuchman/sentrybox:latest", sha],
    [`ghcr.io/pbuchman/sentrybox:sha-${sha.slice(0, 12)}`, sha],
    [valid, "f".repeat(40)],
    [valid, sha, "sha256:abcd"],
  ]) {
    assert.notEqual(spawnSync(process.execPath, [script, ...args]).status, 0);
  }
});

test("Dependabot tracks lockfile, Actions, and pinned base image updates", async () => {
  const dependabot = await source(".github/dependabot.yml");
  for (const ecosystem of ["npm", "github-actions", "docker"]) {
    assert.ok(
      dependabot.includes(`package-ecosystem: ${ecosystem}`),
      `Dependabot is missing ${ecosystem}`,
    );
  }
  assert.doesNotMatch(dependabot, /target-branch:\s*(?!main\b)/u);
});

test("documentation pins the SentryBox release workflow name", async () => {
  const deploymentPlan = await source(
    "docs/superpowers/plans/2026-07-28-home-dev-deployment-and-cutover.md",
  );
  assert.equal(
    Array.from(deploymentPlan.matchAll(/`Release SentryBox Image`/gu)).length,
    2,
  );
  assert.doesNotMatch(deploymentPlan, /Release Error Hub Image/u);
});

test("documentation records current Home Dev capacity", async () => {
  const [specification, deploymentPlan] = await Promise.all([
    source("docs/specification.md"),
    source(
      "docs/superpowers/plans/2026-07-28-home-dev-deployment-and-cutover.md",
    ),
  ]);
  assert.doesNotMatch(specification, /97%/u);
  assert.doesNotMatch(deploymentPlan, /97%/u);
  assert.match(specification, /581 GiB free[\s\S]*?34% used/u);
  assert.match(deploymentPlan, /581 GiB free at 34% used/u);
});

test("network runbook uses the canonical installer and verifies live fragments", async () => {
  const networkRunbook = await source("docs/runbooks/network-exposure.md");
  assert.match(
    networkRunbook,
    /sudo \.\/deploy\/home-dev\/install\.sh \\\n+\s+--private-origin "https:\/\/<home-dev-tailnet-name>:8443"/u,
  );
  assert.match(
    networkRunbook,
    /sudo test -f \/etc\/caddy\/Caddyfile\.d\/sentrybox\.caddy/u,
  );
  assert.match(
    networkRunbook,
    /sudo test -f \/etc\/caddy\/Caddyfile\.d\/sentrybox-deploy\.caddy/u,
  );
  assert.doesNotMatch(
    networkRunbook,
    /(?:sudo\s+)?(?:cp|install)\s+[^\n]*caddy-sentrybox/u,
  );
});

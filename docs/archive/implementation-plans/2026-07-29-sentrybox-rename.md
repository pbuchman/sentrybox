# SentryBox Rename Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename the standalone product and public repository to SentryBox, remove Intexura-specific product positioning, and keep the existing Sentry-compatible behavior and IntexuraOS integration unchanged.

**Architecture:** This is an identity and deployment-contract migration, not a feature rewrite. Source package scopes, image/repository identities, systemd/Caddy/deployment paths, UI copy, and documentation move together; protocol endpoints, DSN format, database schema, event grouping, webhook payloads, and worker compatibility remain unchanged.

**Tech Stack:** GitHub CLI, pnpm workspace, TypeScript, Node.js 22, Docker/GHCR, systemd, Caddy, Tailscale, GitHub Actions.

## Global Constraints

- Product name: `SentryBox`.
- Public repository: `pbuchman/sentrybox`.
- Container image: `ghcr.io/pbuchman/sentrybox`.
- Workspace packages: `@sentrybox/domain`, `@sentrybox/protocol`, `@sentrybox/server`, and `@sentrybox/web`.
- Home Dev checkout: `/home/pbuchman/deploy/sentrybox`.
- Home Dev persistent root: `/home/pbuchman/services/sentrybox`.
- systemd and deployment-state prefixes: `sentrybox` and `/var/lib/sentrybox-deploy`.
- Keep public ingest at `https://errors.intexuraos.cloud`, private Tailscale port `8443`, public ports `8140/8141`, and deployment callback hostname unchanged.
- Keep `ERROR_HUB_*` protocol/runtime environment variables unchanged to avoid an unrelated configuration migration.
- Keep Sentry Envelope, webhook, private REST/MCP, lifecycle, retention, and UI behavior unchanged.
- Describe SentryBox as a general self-hosted Sentry-compatible tracker; IntexuraOS is an integration example and the first Home Dev tenant, not the product definition.
- Delete only `pbuchman/intexura-error-hub`; preserve the complete local Git history and push it to the new public repository.

---

### Task 1: Lock the new repository and runtime identity in tests

**Files:**

- Modify: `test/ci/workflow-policy.test.mjs`
- Modify: `test/container/runtime-contract.test.mjs`
- Modify: `deploy/home-dev/deploy-webhook.test.mjs`
- Modify: `deploy/home-dev/test/deploy.bats`
- Modify: `apps/server/test/workspace.test.ts`
- Modify: `apps/web/test/workspace.test.ts`
- Modify: `packages/domain/test/workspace.test.ts`
- Modify: `packages/protocol/test/workspace.test.ts`

**Interfaces:**

- Consumes: the current immutable image, webhook allowlist, workspace package, service, and path contracts.
- Produces: failing assertions for the exact `sentrybox` mappings in Global Constraints.

- [ ] Change expected repository/image/package/service/path values from `intexura-error-hub` and `@intexura-error-hub/*` to the exact SentryBox values above.
- [ ] Run `pnpm run test:ops` and the four workspace tests; expect failures showing that production files still use the old identity.
- [ ] Do not change protocol, endpoint, database, or behavioral assertions.

### Task 2: Rename workspace and product presentation

**Files:**

- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `vitest.workspace.ts`
- Modify: `Dockerfile`
- Modify: `apps/*/package.json`
- Modify: `packages/*/package.json`
- Modify: TypeScript imports currently using `@intexura-error-hub/*`
- Modify: `README.md`
- Modify: `apps/web/index.html`
- Modify: visible product copy in `apps/web/src/routes/issue-list.tsx`

**Interfaces:**

- Consumes: the failing workspace and product-name tests from Task 1.
- Produces: `SentryBox` UI/README identity and the exact `@sentrybox/*` package graph.

- [ ] Replace the root name with `sentrybox` and package scopes with `@sentrybox/*`; regenerate the pnpm lockfile using Node.js 22 and pnpm `10.29.3`.
- [ ] Change visible title/copy from `Intexura Error Hub` to `SentryBox` without altering UI layout or behavior.
- [ ] Rewrite the README introduction to: an independent, self-hosted, Sentry-compatible error tracker accepting standard Sentry DSNs from multiple applications/projects; document IntexuraOS only as the bundled Home Dev integration example.
- [ ] Run `pnpm typecheck`, `pnpm lint`, workspace tests, and `pnpm build`; expect all renamed package imports and product copy to pass.

### Task 3: Rename immutable release and Home Dev contracts

**Files:**

- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/release-image.yml`
- Modify: `scripts/ci/verify-image-ref.mjs`
- Rename/modify: `deploy/home-dev/intexura-error-hub*.service` to `deploy/home-dev/sentrybox*.service`
- Modify: all `deploy/home-dev/*.sh`, `*.mjs`, `compose.yaml`, Caddy fragments, and examples containing the old repository/image/path/service identity

**Interfaces:**

- Consumes: `pbuchman/sentrybox`, `ghcr.io/pbuchman/sentrybox`, and the fixed Home Dev paths from Global Constraints.
- Produces: a release workflow and deploy/rollback/backup/webhook stack that accepts only the new repository and immutable image identity.

- [ ] Update release source labels, registry token scopes, manifest probes, image references, deployment webhook repository allowlist, systemd unit references, state directories, checkout paths, persistent paths, and Caddy import paths to `sentrybox`.
- [ ] Rename unit files and update every test/installer reference atomically; do not leave compatibility aliases because Home Dev has no existing SentryBox deployment to migrate.
- [ ] Keep hostname, port, credential contents, HMAC algorithm, workflow name, digest pinning, backup bounds, and rollback behavior unchanged.
- [ ] Run `pnpm run test:ops`, shellcheck/bash syntax checks, Bats, Caddy validation fixtures, and `systemd-analyze verify`; expect exact new identity with no old runtime path.

### Task 4: Make specification and runbooks product-neutral

**Files:**

- Modify: `docs/specification.md`
- Modify: `docs/runbooks/*.md`
- Modify: `docs/superpowers/plans/*.md`
- Modify: `scripts/acceptance/*.mjs`

**Interfaces:**

- Consumes: the new repository, image, package, and runtime names.
- Produces: general SentryBox product documentation while preserving the concrete IntexuraOS cutover instructions where they are integration-specific.

- [ ] Rename product/repository/image/path/service references to SentryBox.
- [ ] State explicitly that each configured project/environment receives its own Sentry-compatible DSN and that other applications can report without changing SDK call sites.
- [ ] Keep `intexuraos-backend` and `intexuraos-web` only in the Home Dev sample configuration and IntexuraOS integration/cutover steps.
- [ ] Run `rg -n 'Intexura Error Hub|pbuchman/intexura-error-hub|ghcr.io/pbuchman/intexura-error-hub|@intexura-error-hub|/intexura-error-hub|intexura-error-hub\.service' --glob '!docs/superpowers/plans/2026-07-29-sentrybox-rename.md'`; expect no active product/runtime matches.
- [ ] Run `pnpm format:check`; expect all renamed documentation and scripts to pass.

### Task 5: Recreate the public GitHub repository safely

**Files:**

- Modify external GitHub state only after Tasks 1–4 and the full repository gate pass.

**Interfaces:**

- Consumes: clean, tested local history with SentryBox identity.
- Produces: public `https://github.com/pbuchman/sentrybox` and no `pbuchman/intexura-error-hub` repository.

- [ ] Confirm `pbuchman/intexura-error-hub` exists, `pbuchman/sentrybox` does not exist, local commits contain the complete implementation, and the working tree is clean.
- [ ] Run the full gate: `pnpm test && pnpm test:integration && pnpm typecheck && pnpm lint && pnpm build && pnpm format:check` plus Chromium E2E and Home Dev deployment tests; expect green.
- [ ] Delete exactly `pbuchman/intexura-error-hub` using authenticated GitHub operations; do not delete packages, releases, or any other repository.
- [ ] Create exactly `pbuchman/sentrybox` as a public repository with description `Independent, self-hosted Sentry-compatible error tracking for multiple projects.`
- [ ] Change local `origin` to `git@github.com:pbuchman/sentrybox.git`, push the tested history and feature branch, open a PR to `main`, require green GitHub-hosted CI, merge it, and verify the release workflow publishes `ghcr.io/pbuchman/sentrybox:sha-<merged-sha>`.

### Task 6: Update integration references and deploy the renamed product

**Files:**

- Modify: `/Users/p.buchman/personal/pbuchman-dev` SentryBox checkout/import/service references
- Modify only repository/image/path references in `/Users/p.buchman/personal/intexuraos-2`; keep `ERROR_HUB_HOST`, DSN, webhook, `agentType=sentry`, and completion contracts unchanged
- Rename local checkout after all agents finish: `/Users/p.buchman/personal/intexura-error-hub` to `/Users/p.buchman/personal/sentrybox`

**Interfaces:**

- Consumes: merged immutable SentryBox image and existing Error Hub-compatible integration code.
- Produces: visible SentryBox MVP on Home Dev and the unchanged IntexuraOS DSN/webhook/worker flow.

- [ ] Update the Home Dev configuration branch to import SentryBox Caddy fragments and reference `/home/pbuchman/deploy/sentrybox`; run its repository checks.
- [ ] Update only stale repository/image/path documentation or verification references in IntexuraOS; run `pnpm run ci:tracked` and finalize its PR through `$commit-push` without a fabricated Linear ID.
- [ ] Install and deploy the merged SentryBox digest on Home Dev, configure the existing Cloudflare/Tailscale routes, generate environment-bound DSNs, and complete the existing cutover/acceptance plan.
- [ ] Verify ingest, grouping, idempotency, regression, HMAC Code Agent delivery, private worker evidence, retention, network boundaries, log correlation, resolve/reopen/download/delete, exact/relative timestamps, filters, and mobile/desktop UI in the user's running Google Chrome.

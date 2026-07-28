# Home Dev Deployment and IntexuraOS Cutover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy Error Hub safely on Home Dev, expose only Sentry ingest and a tightly scoped deployment callback publicly, expose operator/worker reads only through Tailscale, and migrate IntexuraOS from SaaS Sentry with measured shadow phases and immediate rollback.

**Architecture:** GitHub-hosted Actions build and publish an immutable public GHCR image. Home Dev runs one hardened container under systemd with two loopback listeners and persistent SQLite storage. Cloudflare Tunnel plus Caddy expose the write-only Envelope endpoint and a separate signed deployment handler; Tailscale Serve exposes the private UI/API. Environment-bound DSNs are switched dev first, then production, while the Hub forwards envelopes to legacy Sentry during comparison windows.

**Tech Stack:** Docker/Compose, systemd, Caddy, Cloudflare Tunnel, Tailscale Serve, GitHub Actions/GHCR, SQLite WAL backup API, existing IntexuraOS deployment scripts and Secret Manager.

## Global Constraints

- The Error Hub repository owns `deploy/home-dev/*`; `pbuchman-dev` only documents installation and references those canonical files.
- Build on GitHub-hosted `ubuntu-latest` only. Never run a public-repository workflow on the Home Dev self-hosted runner.
- Deploy an immutable digest, never `latest`, and do not build the image on Home Dev.
- Bind container listeners only to `127.0.0.1:8140` and `127.0.0.1:8141`.
- Public application traffic is write-only Sentry Envelope ingest plus liveness. UI, search, downloads, issue lifecycle, Sentry-read compatibility, readiness, and metrics stay private.
- Use four environment-bound DSNs: backend-dev, backend-prod, web-dev, web-prod. Reject environment mismatch before storage, forwarding, or webhook routing.
- Keep Hub Code Agent destinations in `disabled` mode during shadow comparison;
  their transitions are audit-only and can never become a backlog.
- Never display, copy into commands, or commit active Cloudflare, GitHub, Sentry, Code Agent, or webhook secret values.
- The currently exposed inline Cloudflare tunnel token must be rotated as a prerequisite by an explicitly authorized operator; this plan does not reuse it.

---

## Task 1: Package a hardened immutable container

**Repository:** `intexura-error-hub`

**Files:**

- Create: `Dockerfile`
- Create: `.dockerignore`
- Create: `deploy/home-dev/compose.yaml`
- Create: `deploy/home-dev/env.example`
- Create: `deploy/home-dev/config.example.json`
- Create: `deploy/home-dev/verify-container.sh`
- Test: `test/container/runtime-contract.test.mjs`

- [ ] Write a failing container contract test that checks non-root UID, read-only root filesystem compatibility, `/tmp`, both loopback-facing container ports, health endpoints, writable `/data`, graceful shutdown, and absence of a shell-time package install.
- [ ] Build the server and web in a pinned Node 22 multi-stage Dockerfile and copy only production dependencies, migrations, server distribution, UI assets, licenses, and CA certificates into the runtime stage.
- [ ] Run as a dedicated numeric non-root UID/GID and expose container ports 8080 for public ingest and 8081 for private traffic.
- [ ] Define Compose hardening:

```yaml
services:
  error-hub:
    image: ${ERROR_HUB_IMAGE:?immutable image digest required}
    environment:
      ERROR_HUB_ENV_FILE: /run/secrets/error-hub-env
    ports:
      - "127.0.0.1:8140:8080"
      - "127.0.0.1:8141:8081"
    read_only: true
    tmpfs:
      - /tmp:size=64m,mode=1777
    cap_drop: [ALL]
    security_opt: [no-new-privileges:true]
    volumes:
      - /home/pbuchman/services/intexura-error-hub/data:/data
      - /home/pbuchman/services/intexura-error-hub/env:/run/secrets/error-hub-env:ro
```

- [ ] Add Docker log rotation, bounded memory/PIDs, `restart: unless-stopped`, and a private `/health/ready` healthcheck without granting extra capabilities.
- [ ] Ensure Compose has no named volume and deployment never uses `down -v`, because host cleanup must not own persistent data.
- [ ] Run the container test and `docker compose -f deploy/home-dev/compose.yaml config`; expect no unbound image variable after supplying a test digest and no listener on `0.0.0.0`.
- [ ] Commit with `build: package hardened error hub container`.

## Task 2: Add public-repository CI and immutable GHCR release

**Repository:** `intexura-error-hub`

**Files:**

- Modify: `.github/workflows/ci.yml`
- Create: `.github/workflows/release-image.yml`
- Create: `.github/dependabot.yml`
- Create: `scripts/ci/verify-image-ref.mjs`

- [ ] Write a failing workflow policy test asserting every job uses a GitHub-hosted runner and no workflow accepts executable input from pull-request payloads.
- [ ] Run lint, typecheck, unit, integration, protocol/MCP compatibility, Playwright, license, dependency audit, secret scan, and Docker build on pull requests without publishing or accessing deployment secrets.
- [ ] On successful `push` to `main`, rebuild from the tested commit, scan the image, publish `linux/amd64` as `ghcr.io/pbuchman/intexura-error-hub:sha-<40-character-sha>`, and expose the immutable manifest digest in the workflow summary.
- [ ] Grant only `contents: read` and `packages: write` to the release job; use default read-only permissions elsewhere.
- [ ] Generate an SBOM and provenance attestation tied to the digest. Do not publish a mutable `latest` tag.
- [ ] Make the workflow name a fixed `Release Error Hub Image`; the deployment handler accepts only this exact name.
- [ ] Run workflow syntax validation and the policy test locally; expect no `self-hosted` string and no unpinned third-party action.
- [ ] Commit with `ci: publish immutable error hub image`.

## Task 3: Create canonical Home Dev service and deployment assets

**Repository:** `intexura-error-hub`

**Files:**

- Create: `deploy/home-dev/intexura-error-hub.service`
- Create: `deploy/home-dev/intexura-error-hub-deploy.service`
- Create: `deploy/home-dev/intexura-error-hub-backup.service`
- Create: `deploy/home-dev/intexura-error-hub-backup.timer`
- Create: `deploy/home-dev/intexura-error-hub-restore-test.service`
- Create: `deploy/home-dev/intexura-error-hub-restore-test.timer`
- Create: `deploy/home-dev/deploy.sh`
- Create: `deploy/home-dev/preflight.sh`
- Create: `deploy/home-dev/rollback.sh`
- Create: `deploy/home-dev/backup.sh`
- Create: `deploy/home-dev/install.sh`
- Test: `deploy/home-dev/test/deploy.bats`

- [ ] Write failing Bats tests for exact target paths, lock contention, minimum 15 GiB free disk, missing immutable digest, failed readiness, successful rollback, backup failure, and rejection of `latest`.
- [ ] Make `install.sh` create and permission only these paths:

```text
/home/pbuchman/deploy/intexura-error-hub
/home/pbuchman/services/intexura-error-hub/env
/home/pbuchman/services/intexura-error-hub/data
/home/pbuchman/services/intexura-error-hub-backups
```

- [ ] Install systemd units from the checked-out repository, use an explicit working directory, restrictive umask, no broad sudo shell, and fixed script paths.
- [ ] Make `preflight.sh` validate configuration, project/environment credential uniqueness, writable data, SQLite integrity, ports 8140/8141, Docker health, and at least 15 GiB host free space.
- [ ] Make `deploy.sh` acquire a host lock, verify repository/SHA/workflow identity, resolve the published tag to a digest, save current SHA/digest, pull, switch Caddy ingest to a bounded `503` plus `Retry-After` maintenance response, create a consistent database backup, set `ERROR_HUB_IMAGE` to the digest, start with `docker compose up -d --wait --remove-orphans`, run private plus synthetic public health checks, and always restore the normal Caddy route.
- [ ] Make `rollback.sh` restore the previous digest and restart first. Restore the database backup only when an integrity/migration check proves it is required.
- [ ] Ensure schema migrations are additive and readable by the immediately previous runtime before permitting the release.
- [ ] Run Bats tests in a disposable temporary root with fake systemctl/docker commands; expect no operation outside the fixture directories.
- [ ] Commit with `ops: add home dev service deployment and rollback`.

## Task 4: Configure projects and environment-bound ingress

**Repository:** `intexura-error-hub`

**Files:**

- Create: `scripts/admin/generate-project-config.mjs`
- Create: `scripts/admin/validate-project-config.mjs`
- Create: `docs/runbooks/project-configuration.md`
- Test: `scripts/admin/project-config.test.mjs`

- [ ] Write failing tests for duplicate project IDs/slugs/keys, key/environment mismatch, missing CORS origins, a forwarding destination in the wrong environment, a Code Agent destination in the wrong environment, and invalid `disabled|live` delivery mode transitions.
- [ ] Generate two logical projects and exactly four key records:

```text
intexuraos-backend + dev
intexuraos-backend + prod
intexuraos-web     + dev
intexuraos-web     + prod
```

- [ ] Hash public keys before SQLite insertion, print DSNs only to the operator terminal once, and write no clear DSN key into repository files or service logs.
- [ ] Bind each key to one exact environment, browser origin allowlist, optional legacy forwarding DSN reference, and Code Agent destination reference.
- [ ] Keep the two logical project IDs stable across environment keys so the UI's project filter does not fragment by environment.
- [ ] Configure dev and production HMAC secrets as separate credential-file references; never put secrets in SQLite. Initialize every Code Agent destination as `disabled`, and require an explicit baseline timestamp when switching it to `live`.
- [ ] Validate with one accepted dev envelope and one rejected envelope that uses the dev key with `environment=prod`; assert the rejected event creates no occurrence, forwarding request, or outbox row.
- [ ] Commit with `ops: configure environment-bound project ingestion`.

## Task 5: Expose public ingest, private UI, and the isolated deploy callback

**Repositories:** `intexura-error-hub` and `pbuchman-dev`

**Files in Error Hub:**

- Create: `deploy/home-dev/caddy-error-hub.caddy`
- Create: `deploy/home-dev/caddy-error-hub-deploy.caddy`
- Create: `deploy/home-dev/configure-tailscale.sh`
- Create: `docs/runbooks/network-exposure.md`
- Test: `deploy/home-dev/test/network-contract.bats`

**Files in pbuchman-dev:**

- Modify: `machine-setup/phase-3-dev-services.md`
- Modify: `machine-setup/config/Caddyfile`

- [ ] Write failing route tests asserting `errors.intexuraos.cloud` proxies only `POST|OPTIONS /api/[0-9]+/envelope/` and `GET /health/live`, while private/API/download routes return 404 at Caddy.
- [ ] Add the exact Caddy ingest contract from specification section 18.4 and validate it with `caddy validate` before reload.
- [ ] Configure Cloudflare Tunnel route `errors.intexuraos.cloud -> http://localhost:80` and verify TLS, CORS preflight, 1 MiB body enforcement, WAF/rate limit, and a synthetic accepted envelope.
- [ ] Apply `sudo tailscale serve --bg --https=8443 http://127.0.0.1:8141`, record `tailscale serve status --json`, and verify UI/private API from an allowed tailnet client and denial from a non-tailnet client.
- [ ] Add a separate Caddy vhost exposing only `POST errors-deploy.intexuraos.cloud/github/workflow-run` to `127.0.0.1:9003`; the Error Hub application and deploy handler remain separate processes.
- [ ] Configure Cloudflare Tunnel route `errors-deploy.intexuraos.cloud -> http://localhost:80` and verify all other methods/paths return 404.
- [ ] Confirm a disposable real Code Worker can reach private HTTPS port 8443 without attaching the Hub to `code-worker-net`; add only a narrow host-gateway route if the test proves it is needed.
- [ ] Update `pbuchman-dev` documentation to point at Error Hub's checked-in deployment assets as canonical; do not copy/fork those files.
- [ ] Commit Error Hub changes with `ops: define public and private network boundaries`; commit the documentation-only `pbuchman-dev` change separately.

## Task 6: Rotate Cloudflare credentials and install the deployment webhook

**Repositories:** `intexura-error-hub` and Home Dev runtime configuration

**Files:**

- Create: `deploy/home-dev/deploy-webhook.mjs`
- Create: `deploy/home-dev/deploy-webhook.test.mjs`
- Create: `deploy/home-dev/intexura-error-hub-deploy-webhook.service`
- Create: `docs/runbooks/credential-rotation.md`

- [ ] Obtain explicit operator authorization and rotate the Cloudflare tunnel token that was previously visible inline in a diagnostic service definition. Do not print the old or new value.
- [ ] Store the replacement as a root/deployment-user-readable credential file, remove inline token use from systemd `ExecStart`, daemon-reload, restart Cloudflared, and verify every pre-existing tunnel route before proceeding.
- [ ] Write failing handler tests for invalid/missing `X-Hub-Signature-256`, body over 1 MiB, repeated `X-GitHub-Delivery`, stale `workflow_run.updated_at`, wrong repository, action, workflow name, event, branch, conclusion, or head SHA.
- [ ] Verify HMAC-SHA256 over exact raw bytes with a dedicated webhook secret and constant-time comparison.
- [ ] Persist accepted delivery IDs before invoking deployment, reject replays for seven days, enforce a five-minute event freshness window, and allow only `action=completed`, `conclusion=success`, `event=push`, `head_branch=main`, repository `pbuchman/intexura-error-hub`, and workflow `Release Error Hub Image`.
- [ ] Resolve the image tag from the verified 40-character head SHA and call only the fixed `deploy/home-dev/deploy.sh`; never evaluate a payload string as a command.
- [ ] Run the handler on loopback port 9003 as a restricted systemd service with a concurrency lock, request timeout, bounded logs, and no access to the Error Hub data directory.
- [ ] Configure the GitHub repository webhook for `workflow_run` only, send a test delivery, and verify one accepted deployment plus one deduplicated redelivery.
- [ ] Commit with `ops: add verified github deployment callback`.

## Task 7: Enforce retention, backup, restore, and operational alerts

**Repository:** `intexura-error-hub`

**Files:**

- Modify: `deploy/home-dev/backup.sh`
- Create: `deploy/home-dev/restore-test.sh`
- Create: `deploy/home-dev/monitor.sh`
- Create: `docs/runbooks/backup-and-recovery.md`
- Create: `docs/runbooks/operations.md`
- Test: `deploy/home-dev/test/backup-retention.bats`

- [ ] Write failing tests for a WAL-active database backup, 23-day backup scrub, aggregate recomputation, interrupted upload, corrupt backup, absent external destination, 5 GiB live limit, backup-staging growth, and restore-test cleanup.
- [ ] Create backups through SQLite's online backup API in the shipped image, not by copying active database/WAL files.
- [ ] In the backup copy, delete events older than 23 days and recompute issue aggregates before encryption. Keep at most one local staging snapshot outside the live data directory, upload it to the existing encrypted external-backed Home Dev backup target, verify checksum, then remove local staging data. Keep seven daily remote generations so no event copy survives beyond 30 days.
- [ ] If the external destination is unavailable, mark backup disabled/degraded visibly rather than accumulating snapshots on the 97%-used root filesystem.
- [ ] Run a monthly restore into a temporary directory, execute integrity/migration/read checks, record success, and remove the temporary copy safely.
- [ ] Alert privately on readiness failure, physical data above 4.5 GiB, ingest disabled at 4.75 GiB, retention failure, dead-letter webhook, backup age over 26 hours, restore-test age over 35 days, or repeated 429/503 responses.
- [ ] Verify journald contains structured operational metadata but no event payloads, DSNs, HMACs, tokens, or downloaded exports.
- [ ] Run backup/restore tests with a generated SQLite fixture; expect checksums and restored counts to match.
- [ ] Commit with `ops: add bounded backup and recovery checks`.

## Task 8: Run the development shadow phase

**Repositories:** `intexura-error-hub`, `intexuraos-2`, and Home Dev runtime configuration

**Files:**

- Create in Hub: `docs/runbooks/dev-shadow-cutover.md`
- Create in Hub: `scripts/acceptance/compare-shadow-events.mjs`

- [ ] Record current dev backend/web DSNs by secret reference only, current Sentry webhook configuration, deployed IntexuraOS SHA, Hub image digest, and rollback owner/time window.
- [ ] Deploy Hub with Code Agent destinations in `disabled` mode and dev legacy-forwarding enabled; verify new shadow transitions are recorded only as non-dispatchable `suppressed` rows.
- [ ] Change only `INTEXURAOS_SENTRY_DSN` and `INTEXURAOS_SENTRY_DSN_WEB` in `/home/pbuchman/deploy/intexuraos/.envrc.local` to the environment-bound Hub dev DSNs.
- [ ] Reload PM2 with updated environment, restart the orchestrator and affected non-PM2 workers, and rebuild/restart the dev Vite web so its build-time DSN changes.
- [ ] Emit controlled backend warning/error/fatal and browser error events. Verify no debug/info persistence, project/release/environment/service facets, stack/breadcrumb redaction, exact times, grouping, downloads, and log locators.
- [ ] Compare event IDs and supported fields between Hub and shadow-forwarded Sentry for at least 48 hours. Record accepted, discarded, forwarded, failed, grouped, and storage-growth counts.
- [ ] Stop if any supported event reaches Sentry but not Hub, telemetry changes an application response, environment/key mismatch is accepted, redaction fails, or projected storage exceeds the budget.
- [ ] After the Code Agent lease fix and real-worker MCP test are deployed, disable only dev Sentry webhook sources and enable only Hub dev destinations. Verify suppressed shadow rows remain non-dispatchable and the pending queue is empty at the baseline.
- [ ] Run one controlled creation and one resolved regression; verify one Linear issue and Code Task per transition, correct worker type, Hub evidence read, unchanged completion contract, and successful outbox state.
- [ ] Keep dev shadow forwarding enabled through the production decision.

## Task 9: Run production shadow, cutover, and rollback drill

**Repositories:** `intexura-error-hub`, `intexuraos-2`, and production configuration

**Files:**

- Create in Hub: `docs/runbooks/production-cutover.md`
- Create in Hub: `docs/runbooks/rollback.md`
- Create in Hub: `scripts/acceptance/cutover-gate.mjs`

- [ ] Require signed evidence that every development acceptance item passed, no unresolved dead letters exist, backup/restore checks pass, 5 GiB forecast is safe, and a rollback drill has restored a prior Hub digest.
- [ ] Configure production legacy forwarding and Code Agent destination references, but leave Hub production destinations in `disabled` mode and verify suppression semantics before traffic.
- [ ] Replace the production backend and web DSN values in the existing Secret Manager entries with the two environment-bound Hub production DSNs; do not alter application call sites.
- [ ] Run the normal Hetzner deployment so backend environment and the build-time web DSN are refreshed; redeploy retained Cloud Functions/workers that consume `INTEXURAOS_SENTRY_DSN`.
- [ ] Emit controlled production backend and browser events and compare Hub with shadow-forwarded Sentry for at least 48 hours across project, release, environment, service, level, event ID, payload evidence, and volume.
- [ ] Freeze cutover if Home Dev, Cloudflare Tunnel, Tailscale worker access, outbox, backup, retention, or storage health is degraded.
- [ ] Disable the two migrated production Sentry webhook sources, then enable the matching Hub production destinations. Never leave both automation sources active.
- [ ] Run one controlled production creation and regression, then immediately disable the controlled alert. Verify exact one-task behavior and record Hub/Linear/Code Task/PR evidence.
- [ ] Perform a timed rollback drill: disable Hub webhooks first, re-enable Sentry webhooks, restore old DSN secret versions, run the normal backend/web/function deployment, and confirm new telemetry reaches Sentry. Then return to Hub only after review.
- [ ] Keep old secret versions and dual MCP configuration through seven stable days; never delete rollback evidence during cutover.

## Task 10: Retire active SaaS Sentry paths after the stability window

**Repositories:** `intexura-error-hub` and `intexuraos-2`

**Files:**

- Create in Hub: `docs/runbooks/sentry-retirement.md`
- Modify after all historical tasks are terminal: `docker/code-worker/config-defaults/codex-config.toml`
- Modify after all historical tasks are terminal: `workers/orchestrator/src/bootstrap/env-config.ts`
- Modify after all historical tasks are terminal: `workers/orchestrator/src/services/isolation/worker-env.ts`

- [ ] After seven stable production days, verify no supported event mismatch, no unresolved delivery/retention failure, and no runtime DSN points directly to SaaS Sentry.
- [ ] Disable Hub-to-Sentry forwarding and verify Hub counts remain stable for 24 hours.
- [ ] Keep historical issue URLs and the SaaS MCP/token while any historical Sentry Code Task can still run or resume.
- [ ] When all historical tasks are terminal, remove the old MCP entry and make the old Sentry token unnecessary in a separate tested IntexuraOS change; preserve `sentry` task field names and completion contracts.
- [ ] Cancel or downgrade Sentry only after a repository, Secret Manager, Home Dev runtime, Hetzner runtime, function, and worker audit finds no active dependency.
- [ ] Do not import old Sentry history into Error Hub; historical links remain historical and Hub retention starts at cutover ingestion.

## Endpoint Changes

### Modified

- `errors.intexuraos.cloud` gains a Caddy route limited to Sentry Envelope writes
  and liveness; existing hosts and paths remain untouched.
- Home Dev private Tailscale Serve gains HTTPS port 8443 for Error Hub UI/read
  traffic.

### Created

- Public `POST|OPTIONS https://errors.intexuraos.cloud/api/{projectId}/envelope/`.
- Public `GET https://errors.intexuraos.cloud/health/live`.
- Public, HMAC-verified
  `POST https://errors-deploy.intexuraos.cloud/github/workflow-run` routed only
  to the separate deployment handler.
- Private UI, read/admin, download, readiness, metrics, and Sentry-compatible
  worker routes at the configured Tailscale hostname on port 8443.

### Removed

- After stable cutover only: active SaaS Sentry webhook sources and direct DSN
  reporting to SaaS Sentry. DSN reporting to Error Hub remains the primary
  ingest mechanism. Historical Sentry issue URLs are retained.

### Unchanged

- IntexuraOS Code Agent endpoint `POST /api/code/webhooks/sentry`.
- All pre-existing Home Dev public host routes other than the two explicitly
  added Error Hub hostnames.

## Completion gate

- [ ] Record immutable Hub and IntexuraOS SHAs/digests, project/environment key mapping, public/private route probes, backup/restore result, and all dev/prod acceptance evidence without secret values.
- [ ] Confirm external probes cannot read UI/API data and tailnet clients can perform the intended operator/worker reads.
- [ ] Confirm applications report with only DSN value changes and current SDK call sites are unchanged.
- [ ] Confirm project, version including **Unknown version**, environment, service, severity, time, status, download, resolve/reopen/delete, webhook, and log-locator acceptance paths.
- [ ] Confirm one new issue and one regression produce exactly one current Code Task each, while a raw-body retry produces none.
- [ ] Confirm rollback can restore Sentry reporting and the previous Hub image without database reversal.

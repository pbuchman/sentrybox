# Project configuration

This runbook creates the two IntexuraOS projects and their four
environment-bound Sentry-compatible DSNs. It never stores a clear Hub public
key in a repository file, SQLite column, container log, or validation output.

## Fixed configuration

The non-secret manifest at
`deploy/home-dev/config.example.json` is mounted read-only in the container as
`/run/config/error-hub-projects.json`. It defines exactly this matrix:

| Project | Project ID | Environment | Browser origin |
| --- | ---: | --- | --- |
| `intexuraos-backend` | 1 | `dev` | `https://dev.intexuraos.cloud` |
| `intexuraos-backend` | 1 | `prod` | `https://intexuraos.cloud` |
| `intexuraos-web` | 2 | `dev` | `https://dev.intexuraos.cloud` |
| `intexuraos-web` | 2 | `prod` | `https://intexuraos.cloud` |

Each record binds one environment to one legacy Sentry forwarding reference
and one Code Agent destination. Development and production use different Code
Agent HMAC references. All Code Agent destinations start in `disabled` mode.

## Prerequisites

1. Start the Error Hub once so its database migrations complete.
2. Put the four current legacy Sentry DSNs in
   `/home/pbuchman/services/intexura-error-hub/env`, using the reference names
   from `deploy/home-dev/env.example`. Set mode `0600` and the runtime UID/GID.
3. Do not add the Code Agent HMAC values yet. The credential parser rejects
   entries that are not in `ERROR_HUB_REQUIRED_SECRET_REFERENCES`.
4. Confirm `/health/ready` is healthy and the Code Agent destinations are still
   disabled.

## Generate the four DSNs once

Run from `/home/pbuchman/deploy/intexura-error-hub/deploy/home-dev`:

```bash
docker compose exec -T error-hub node \
  scripts/admin/generate-project-config.mjs \
  --database /data/error-hub.sqlite \
  --config /run/config/error-hub-projects.json
```

The command commits all two projects and four key hashes in one SQLite
transaction, then prints the four clear DSNs to that operator terminal once.
Copy them directly to their intended Home Dev configuration or production
secret entry. Do not redirect the output to a file or paste it into an issue,
commit, deployment log, or chat.

The command refuses to run when any project configuration already exists. It
therefore cannot rotate keys implicitly or print an existing key again.

Validate the stored non-secret state:

```bash
docker compose exec -T error-hub node \
  scripts/admin/validate-project-config.mjs \
  --database /data/error-hub.sqlite \
  --config /run/config/error-hub-projects.json \
  --webhook-mode disabled
```

The validation checks project identity, environment binding, unique 32-byte
key hashes, exact CORS origins, forwarding references, and disabled webhook
state. It never emits a hash or DSN.

## Enable Code Agent delivery

Do this only after the shadow phase and the Code Agent reservation fix have
been verified.

1. Put public ingest into the checked-in maintenance route and stop the Hub.
2. Add `CODE_AGENT_HMAC_DEV` and `CODE_AGENT_HMAC_PROD` to the mode-`0600`
   credential file without printing their values.
3. Set `ERROR_HUB_REQUIRED_SECRET_REFERENCES` to the four legacy Sentry
   references plus those two HMAC references.
4. Start a one-off container with the same data/config mounts and run the
   transition with one explicit UTC baseline:

```bash
docker compose run --rm --no-deps error-hub node \
  scripts/admin/generate-project-config.mjs \
  --database /data/error-hub.sqlite \
  --config /run/config/error-hub-projects.json \
  --enable-code-agent-at 2026-07-28T13:00:00.000Z
```

5. Start the service, restore the normal ingest route, and validate against the
   same baseline:

```bash
docker compose exec -T error-hub node \
  scripts/admin/validate-project-config.mjs \
  --database /data/error-hub.sqlite \
  --config /run/config/error-hub-projects.json \
  --webhook-mode live \
  --enabled-at 2026-07-28T13:00:00.000Z
```

The transition is atomic. It fails if any destination is missing, already
live, cross-environment, or does not match the manifest.

## Disable Code Agent delivery

For rollback, use the same maintenance window and atomically clear all four
live destination fields:

```bash
docker compose run --rm --no-deps error-hub node \
  scripts/admin/generate-project-config.mjs \
  --database /data/error-hub.sqlite \
  --config /run/config/error-hub-projects.json \
  --disable-code-agent-at 2026-07-28T15:00:00.000Z
```

Restart with only the four legacy forwarding references in the credential file
and required-reference list, then validate with `--webhook-mode disabled`.

## Environment-mismatch acceptance check

Before cutover, send one controlled `dev` envelope through a dev DSN and verify
one occurrence. Then send a different event through that same DSN with
`environment=prod`. The second request must return a Sentry-compatible `400`,
and the event, occurrence count, shadow-forward queue, and webhook outbox must
remain unchanged. This contract is also covered by the server ingest test.

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
| `intexuraos-backend` | 1 | `dev` | `http://localhost:3000`, `https://dev.intexuraos.cloud` |
| `intexuraos-backend` | 1 | `prod` | `https://intexuraos.cloud` |
| `intexuraos-web` | 2 | `dev` | `http://localhost:3000`, `https://dev.intexuraos.cloud` |
| `intexuraos-web` | 2 | `prod` | `https://intexuraos.cloud` |

Each record binds one environment to one legacy Sentry forwarding reference
and one Code Agent destination. Development and production use different Code
Agent HMAC references. All Code Agent destinations start in `disabled` mode.
The single HTTP exception is the exact local Vite origin
`http://localhost:3000`, and it is valid only on development keys. Production
keys and localhost lookalikes remain invalid.

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
docker compose exec error-hub node \
  scripts/admin/generate-project-config.mjs \
  --database /data/error-hub.sqlite \
  --config /run/config/error-hub-projects.json
```

The command writes all four clear DSNs synchronously to that operator terminal
inside the same SQLite transaction and commits only after the write succeeds.
If the terminal disconnects, the transaction rolls back and the command can be
retried without losing the generated keys.
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
2. For the dev cutover, add only `CODE_AGENT_HMAC_DEV` to the mode-`0600`
   credential file without printing its value. Add `CODE_AGENT_HMAC_PROD` only
   during the later production cutover.
3. Add the matching HMAC name to `ERROR_HUB_REQUIRED_SECRET_REFERENCES`.
4. Start a one-off container with the same data/config mounts and run the
   transition with one explicit UTC baseline:

```bash
docker compose run --rm --no-deps error-hub node \
  scripts/admin/generate-project-config.mjs \
  --database /data/error-hub.sqlite \
  --config /run/config/error-hub-projects.json \
  --environment dev \
  --enable-code-agent-at 2026-07-28T13:00:00.000Z
```

5. Start the service, restore the normal ingest route, and validate against the
   same baseline:

```bash
docker compose exec -T error-hub node \
  scripts/admin/validate-project-config.mjs \
  --database /data/error-hub.sqlite \
  --config /run/config/error-hub-projects.json \
  --environment dev \
  --webhook-mode live \
  --enabled-at 2026-07-28T13:00:00.000Z
```

The transition changes exactly the two destinations in the selected
environment and is atomic. Production remains disabled during the dev phase.
Repeat with `--environment prod` and a new production baseline only at the
production cutover. A missing HMAC reference makes readiness return `503`.

## Disable Code Agent delivery

For rollback, use the same maintenance window and atomically clear only the
selected environment's live destination fields:

```bash
docker compose run --rm --no-deps error-hub node \
  scripts/admin/generate-project-config.mjs \
  --database /data/error-hub.sqlite \
  --config /run/config/error-hub-projects.json \
  --environment dev \
  --disable-code-agent-at 2026-07-28T15:00:00.000Z
```

Remove the matching HMAC only after disabling that environment, restart, and
validate it with `--environment dev --webhook-mode disabled`.

## Disable legacy Sentry shadow forwarding

After the required stable observation window, permanently stop forwarding the
selected environment to Sentry without manual SQL:

```bash
docker compose run --rm --no-deps error-hub node \
  scripts/admin/generate-project-config.mjs \
  --database /data/error-hub.sqlite \
  --config /run/config/error-hub-projects.json \
  --environment dev \
  --disable-forwarding-at 2026-08-04T13:00:00.000Z
```

Validate with `--environment dev --forwarding-mode disabled`, then remove only
the two matching legacy DSN references from the credential file and required
reference list. Repeat for `prod` only after its independent stability window.

## Environment-mismatch acceptance check

Before cutover, send one controlled `dev` envelope through a dev DSN and verify
one occurrence. Then send a different event through that same DSN with
`environment=prod`. The second request must return a Sentry-compatible `400`,
and the event, occurrence count, shadow-forward queue, and webhook outbox must
remain unchanged. This contract is also covered by the server ingest test.

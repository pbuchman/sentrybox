# Project configuration

SentryBox supports multiple applications and projects. Every configured
project/environment pair receives its own Sentry-compatible DSN, so another
application that already uses a Sentry SDK can report by changing only its DSN;
its SDK call sites stay unchanged.

This runbook installs the bundled Home Dev sample: two IntexuraOS projects and
their four environment-bound DSNs. It never stores a clear SentryBox public key
in a repository file, SQLite column, container log, or validation output.

## Bundled Home Dev sample configuration

The non-secret manifest at
`deploy/home-dev/config.example.json` is mounted read-only in the container as
`/run/config/sentrybox-projects.json`. It defines exactly this matrix:

| Project | Project ID | Environment | Browser origin |
| --- | ---: | --- | --- |
| `intexuraos-backend` | 1 | `dev` | `http://localhost:3000`, `https://dev.intexuraos.cloud` |
| `intexuraos-backend` | 1 | `prod` | `https://intexuraos.cloud` |
| `intexuraos-web` | 2 | `dev` | `http://localhost:3000`, `https://dev.intexuraos.cloud` |
| `intexuraos-web` | 2 | `prod` | `https://intexuraos.cloud` |

Each record has forwarding permanently `disabled` with no forwarding secret
reference, and binds one environment to one Code Agent destination. Development
and production use different Code Agent HMAC references. All Code Agent
destinations start in `disabled` mode.
The single HTTP exception is the exact local Vite origin
`http://localhost:3000`, and it is valid only on development keys. Production
keys and localhost lookalikes remain invalid.

## Prerequisites

1. Before the first install or service start, follow the exact two-name
   [credential bootstrap in the network-exposure runbook](network-exposure.md#bootstrap-service-credentials-before-installation).
   It creates mode-`0600` `/home/pbuchman/services/sentrybox/env` without
   exposing values in a command, environment variable, repository file, or log.
2. Run `install.sh` only after that bootstrap, then let the first start complete
   database migrations.
3. Confirm `/health/ready` is healthy and the Code Agent destinations are still
   disabled.
4. Put the credential-free HTTPS Grafana Explore URL in the second line of
   `/var/lib/sentrybox-deploy/runtime.env` so event details can open matching
   logs. Keep the required-reference list as the first line:

```dotenv
ERROR_HUB_REQUIRED_SECRET_REFERENCES=CODE_AGENT_HMAC_DEV,CODE_AGENT_HMAC_PROD
ERROR_HUB_GRAFANA_EXPLORE_URL=https://<grafana-stack-host>/explore?orgId=1&datasource=<loki-datasource-uid>
```

The file remains root-owned, mode `0600`, and singly linked. SentryBox uses a
field-bounded LogQL identifier filter so the same locator works for Home Dev
PM2 text lines and structured production lines. The `datasource` parameter is
configuration input; SentryBox converts it to Grafana's versioned `panes`
deep-link format together with the exact query and time range.

## Generate the four DSNs once

Run from `/home/pbuchman/deploy/sentrybox/deploy/home-dev`:

```bash
sudo docker compose --env-file /var/lib/sentrybox-deploy/current.env exec sentrybox node \
  scripts/admin/generate-project-config.mjs \
  --database /data/error-hub.sqlite \
  --config /run/config/sentrybox-projects.json
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
sudo docker compose --env-file /var/lib/sentrybox-deploy/current.env exec -T sentrybox node \
  scripts/admin/validate-project-config.mjs \
  --database /data/error-hub.sqlite \
  --config /run/config/sentrybox-projects.json \
  --webhook-mode disabled
```

The validation checks project identity, environment binding, unique 32-byte
key hashes, exact CORS origins, disabled forwarding with no reference, and
disabled webhook state. It never emits a hash or DSN.

## Enable Code Agent delivery

Do this only after the Code Agent reservation fix and steady-state readiness
have been verified. Put the following steps in one root-owned, mode-`0700`
operator script under `/run`; the script must not enable shell tracing or print
a credential. Execute it with an explicit UTC baseline while the checked-in
maintenance wrapper owns the deployment lock:

```bash
baseline="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
sudo ./deploy/home-dev/maintenance-window.sh -- \
  /run/sentrybox-enable-code-agent-dev "${baseline}"
```

The operator script starts with the baseline guard below, so every later
command reads the same positional argument:

```bash
#!/usr/bin/env bash
set -euo pipefail
baseline="${1:?UTC baseline is required}"
[[ "${baseline}" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.000Z$ ]]

source /home/pbuchman/deploy/sentrybox/deploy/home-dev/common.sh
error_hub_read_state "${error_hub_current_state}"
private_origin="${ERROR_HUB_STATE_PRIVATE_ORIGIN}"
service_recovery_required=0

recover_service() {
  local exit_status=$?
  local recovery_status=0
  trap - EXIT
  set +e
  if (( service_recovery_required == 1 )); then
    systemctl start sentrybox.service || recovery_status=70
  fi
  systemctl is-active --quiet sentrybox.service || recovery_status=70
  curl --fail --silent --show-error --connect-timeout 2 --max-time 5 \
    --header "Host: ${private_origin#https://}" \
    http://127.0.0.1:8141/health/ready >/dev/null || recovery_status=70
  if (( recovery_status != 0 )); then
    printf 'SentryBox could not be recovered before leaving maintenance.\n' >&2
    exit_status="${recovery_status}"
  fi
  exit "${exit_status}"
}
trap recover_service EXIT
```

Remove the `/run` script after the validated transition. Its operations, in
this exact order, are:

1. Set `service_recovery_required=1` before running
   `systemctl stop sentrybox.service`. The conservative flag makes the EXIT trap
   restart and probe the service even when the stop fails or is interrupted; a
   redundant start is safe.
2. Confirm the mode-`0600` credential file still contains exactly
   `CODE_AGENT_HMAC_DEV` and `CODE_AGENT_HMAC_PROD`, without printing either
   value. Confirm the first line of `/var/lib/sentrybox-deploy/runtime.env` is
   exactly `ERROR_HUB_REQUIRED_SECRET_REFERENCES=CODE_AGENT_HMAC_DEV,CODE_AGENT_HMAC_PROD`.
   Preserve any second `ERROR_HUB_GRAFANA_EXPLORE_URL` line byte-for-byte. This
   file is the persistent source used by normal starts, deployments, and
   rollbacks; do not export values only in an interactive shell.
3. Start a one-off container with the same data/config mounts and run the
   transition with that same baseline argument:

```bash
sudo docker compose --env-file /var/lib/sentrybox-deploy/current.env run --rm --no-deps sentrybox node \
  scripts/admin/generate-project-config.mjs \
  --database /data/error-hub.sqlite \
  --config /run/config/sentrybox-projects.json \
  --environment dev \
  --enable-code-agent-at "${baseline}"
```

4. Start `sentrybox.service`; only after that command succeeds, set
   `service_recovery_required=0`. Then validate development as live against the
   same baseline and production as disabled before the operator script exits:

```bash
sudo docker compose --env-file /var/lib/sentrybox-deploy/current.env exec -T sentrybox node \
  scripts/admin/validate-project-config.mjs \
  --database /data/error-hub.sqlite \
  --config /run/config/sentrybox-projects.json \
  --environment dev \
  --webhook-mode live \
  --enabled-at "${baseline}"

sudo docker compose --env-file /var/lib/sentrybox-deploy/current.env exec -T sentrybox node \
  scripts/admin/validate-project-config.mjs \
  --database /data/error-hub.sqlite \
  --config /run/config/sentrybox-projects.json \
  --environment prod \
  --webhook-mode disabled
```

The transition changes exactly the two destinations in the selected
environment and is atomic. Production remains disabled during the dev phase.
Repeat with `--environment prod` and a new production baseline only at the
production cutover. A missing HMAC reference makes readiness return `503`.
The maintenance wrapper restores the normal checked-in route only after the
operator script exits and does so even when the script fails. The operator
script's EXIT trap must remain installed for the whole transaction; it retries
the service start and verifies private readiness before control returns to the
wrapper.

## Disable Code Agent delivery

For rollback, use the same maintenance window and atomically clear only the
selected environment's live destination fields:

```bash
sudo docker compose --env-file /var/lib/sentrybox-deploy/current.env run --rm --no-deps sentrybox node \
  scripts/admin/generate-project-config.mjs \
  --database /data/error-hub.sqlite \
  --config /run/config/sentrybox-projects.json \
  --environment dev \
  --disable-code-agent-at 2026-07-28T15:00:00.000Z
```

Keep both HMAC values and their two-name runtime reference list in place: they
are the steady-state credential contract. Then start the service and validate it
with `--environment dev --webhook-mode disabled`.

## Environment-mismatch acceptance check

As a post-cutover regression check, send one controlled `dev` envelope through
a dev DSN and verify one occurrence. Then send a different event through that
same DSN with
`environment=prod`. The second request must return a Sentry-compatible `400`,
and the event, occurrence count, and webhook outbox must remain unchanged.
Forwarding is disabled for every bundled key. This contract is also covered by
the server ingest test.

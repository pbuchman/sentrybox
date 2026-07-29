# Home Dev credential rotation

This procedure removes the Cloudflare tunnel token from the systemd command
line and installs the verified GitHub deployment webhook. Secret values must
never be printed, committed, pasted into an issue/chat, or passed as command
arguments.

## Preconditions

1. Record the current public hostnames and verify each one immediately before
   the change. At minimum this includes every hostname currently assigned to
   the `home-dev` tunnel; do not infer the list from this repository.
2. Confirm `cloudflared`, Caddy, Tailscale, Docker, and the existing
   IntexuraOS services are healthy.
3. Keep a second authenticated session open so a failed restart can be
   repaired without relying on the tunnel.

## Rotate the Cloudflare tunnel token

1. In Cloudflare Zero Trust, open the existing `home-dev` tunnel and rotate its
   connector token. Copy it with the browser's copy control; do not expose it
   in screenshots, terminal history, process arguments, or captured output.
2. In an interactive root session with history disabled and `umask 077`, write
   that clipboard value to:

   `/home/pbuchman/services/intexura-error-hub-deploy/cloudflare-tunnel-token`

   The file must be owned by root, be a regular file, contain exactly one
   non-empty line, and have mode `0600`.
3. Install the checked-in `deploy/home-dev/cloudflared.service` over
   `/etc/systemd/system/cloudflared.service`. Its `ExecStart` uses only
   `--token-file` with a systemd credential path; it contains no credential.
4. Run `systemctl daemon-reload`, restart `cloudflared`, and require it to be
   active before continuing. Inspect the effective unit and process arguments
   to confirm that no token value is present.
5. Re-run the complete pre-change hostname probe list. A failure is a stop
   condition: keep the new credential file, repair the route/service, and do
   not install the GitHub webhook until every pre-existing route is healthy.

The old token is invalid after the provider rotation. Do not keep a copy in a
unit backup, shell history, note, or repository.

## Install the deployment webhook

1. Generate a dedicated random GitHub webhook secret in a non-logging process
   and store it as the mode-`0600` root-owned file:

   `/home/pbuchman/services/intexura-error-hub-deploy/github-webhook-secret`

2. Install `intexura-error-hub-deploy-webhook.service` and the deployment unit,
   then run `systemd-analyze verify` on both. Enable the handler only after the
   deployment unit has passed its fixture tests.
3. Configure the GitHub repository webhook with:

   - URL: `https://errors-deploy.intexuraos.cloud/github/workflow-run`
   - content type: `application/json`
   - event: workflow runs only
   - active: yes

   Use the exact same dedicated secret from step 1. Do not reuse a Cloudflare,
   Code Agent, or Sentry secret.
4. Send one GitHub test delivery. Require HTTP `202`, one deployment of the
   exact successful `main` workflow SHA, and a persisted delivery ID. Redeliver
   the same request and require HTTP `409` with no second deployment.
5. Verify requests with a missing/invalid signature, stale timestamp, wrong
   repository/workflow/event/branch/conclusion/SHA, wrong path or method, and a
   body above one MiB are rejected without invoking the deploy unit.

## Evidence without secret disclosure

Record only timestamps, service states, HTTP status codes, GitHub delivery ID,
workflow SHA, deployed image digest, and the fact that credential files passed
owner/mode checks. Never record credential contents or hashes.

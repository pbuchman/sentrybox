# Network exposure

SentryBox has three deliberately separate network surfaces. Do not collapse
them onto one listener or attach the application container to a public Docker
network.

| Surface | Address | Allowed operations |
| --- | --- | --- |
| Public ingest | `https://errors.intexuraos.cloud` | `POST|OPTIONS /api/{numericProjectId}/envelope/`, `GET /health/live` |
| Private application | Runtime `ERROR_HUB_PRIVATE_ORIGIN` on Tailscale HTTPS port `8443` | UI, private API, exports, MCP/worker reads, readiness, metrics |
| Deployment callback | `https://errors-deploy.intexuraos.cloud` | `POST /github/workflow-run` only |

The public hostnames terminate TLS at Cloudflare Tunnel and reach Caddy over
Home Dev loopback HTTP. The private application is served by Tailscale and has
no application login because tailnet ACLs are the access boundary.

## Bootstrap service credentials before installation

Before the first `install.sh` run, create the exact two-name credential file.
The installer fails closed and starts no service when this file is absent,
empty, malformed, or contains any extra name. Run this on Home Dev; it prompts on the terminal and never places either value
in a command argument, environment variable, repository file, or log:

```bash
sudo bash -c '
set -euo pipefail
credential_file=/var/lib/sentrybox/env
install -d -m 0700 /var/lib/sentrybox
read -r -s -p "CODE_AGENT_HMAC_DEV: " code_agent_hmac_dev
printf "\n" >&2
read -r -s -p "CODE_AGENT_HMAC_PROD: " code_agent_hmac_prod
printf "\n" >&2
[[ -n "${code_agent_hmac_dev}" && -n "${code_agent_hmac_prod}" ]]
temporary_file="$(mktemp "${credential_file}.XXXXXX")"
trap "rm -f -- \"${temporary_file}\"" EXIT
printf "CODE_AGENT_HMAC_DEV=%s\nCODE_AGENT_HMAC_PROD=%s\n" \
  "${code_agent_hmac_dev}" "${code_agent_hmac_prod}" >"${temporary_file}"
chown "$(id -u pbuchman):$(id -g pbuchman)" "${temporary_file}"
chmod 0600 "${temporary_file}"
mv -f "${temporary_file}" "${credential_file}"
unset code_agent_hmac_dev code_agent_hmac_prod
'
```

Do not add Sentry DSNs, a third name, blank values, or duplicate names. The
runtime UID/GID must retain access to this mode-`0600` regular file.

## Install the Caddy fragments

The canonical fragments are:

- `deploy/home-dev/caddy-sentrybox.caddy`
- `deploy/home-dev/caddy-sentrybox-maintenance.caddy`
- `deploy/home-dev/caddy-sentrybox-deploy.caddy`

Installation copies the normal ingest and deploy callback sources to these live
paths; the maintenance source stays in the protected control release until
a deployment or operator window activates it:

- `/etc/caddy/Caddyfile.d/sentrybox.caddy`
- `/etc/caddy/Caddyfile.d/sentrybox-deploy.caddy`

The Home Dev Caddyfile imports `/etc/caddy/Caddyfile.d/*.caddy`; it does not
import either source directly from the protected control directory. When
`sentrybox-deploy.service` runs the deployment transaction, only the live
`sentrybox.caddy` ingest fragment is temporarily replaced from the checked-in
maintenance fragment and then restored from `deploy/home-dev/caddy-sentrybox.caddy`.
The maintenance route returns `503` plus `Retry-After: 120` for both envelope
methods. The live deploy callback fragment remains unchanged.

For an operator change, run the complete change through the checked-in wrapper:

```bash
sudo /opt/sentrybox-control/current/deploy/home-dev/maintenance-window.sh -- /absolute/path/to/operator-command argument
```

The wrapper holds `/var/lib/sentrybox-deploy/deployment.lock`, installs the checked-in
maintenance fragment, validates the complete Caddy configuration before each
reload, and restores the normal fragment on success, command failure, or a
handled signal. The operator command must contain the complete transaction; do
not enter maintenance in one command and perform the change after its lock has
been released.

After the credential bootstrap completes, follow the
[protected control installation](protected-control.md) using the actual
private tailnet origin.

Then verify the installed live fragments before every reload:

```bash
sudo test -f /etc/caddy/Caddyfile.d/sentrybox.caddy
sudo test -f /etc/caddy/Caddyfile.d/sentrybox-deploy.caddy
sudo env \
  XDG_CONFIG_HOME=/var/lib/sentrybox-deploy/caddy-validation/config \
  XDG_DATA_HOME=/var/lib/sentrybox-deploy/caddy-validation/data \
  caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

The dedicated validation directories keep Caddy's internal-PKI validation
state in its private runtime directory.

## Bootstrap the first verified deployment

Use a GitHub fine-grained personal access token scoped only to
`pbuchman/sentrybox`, with **Actions: read**. Provision it atomically as a
root-owned, mode-`0600`, singly linked regular file at the single fixed source
`/var/lib/sentrybox-deploy/bootstrap-github-token`. Never put the token in an
argument, environment variable, checkout, long-lived credential file, or log.
The complete parent directory chain must be root-owned with the exact modes
validated below.

```bash
# Provision in a history-disabled interactive root shell.
sudo -i
set +o history
set -o noclobber
umask 077
token_file=/var/lib/sentrybox-deploy/bootstrap-github-token
test ! -e "${token_file}" && test ! -L "${token_file}"
temporary="$(mktemp /var/lib/sentrybox-deploy/.bootstrap-github-token.XXXXXX)"
trap 'rm -f -- "${temporary}"' EXIT
read -rsp 'One-time GitHub Actions-read token: ' bootstrap_token
printf '\n'
printf '%s\n' "${bootstrap_token}" >|"${temporary}"
unset bootstrap_token
chown root:root "${temporary}"
chmod 0600 "${temporary}"
mv -f -- "${temporary}" "${token_file}"
trap - EXIT
exit

# Validate the fixed source and every parent without reading the token.
test "$(sudo stat -c '%a:%U:%G:%F' /)" = '755:root:root:directory'
test "$(sudo stat -c '%a:%U:%G:%F' /var)" = '755:root:root:directory'
test "$(sudo stat -c '%a:%U:%G:%F' /var/lib)" = '755:root:root:directory'
test "$(sudo stat -c '%a:%U:%G:%F' /var/lib/sentrybox-deploy)" = \
  '700:root:root:directory'
sudo test -f /var/lib/sentrybox-deploy/bootstrap-github-token
sudo test ! -L /var/lib/sentrybox-deploy/bootstrap-github-token
test "$(sudo stat -c '%a:%h:%U:%G:%F' \
  /var/lib/sentrybox-deploy/bootstrap-github-token)" = \
  '600:1:root:root:regular file'
```

Run the bootstrap once on a new host:

```bash
sudo systemctl start sentrybox-deploy-bootstrap.service
sudo systemctl show sentrybox-deploy-bootstrap.service \
  --property=Result --value | grep -Fx success
sudo test ! -e /var/lib/sentrybox-deploy/bootstrap-github-token
sudo test ! -L /var/lib/sentrybox-deploy/bootstrap-github-token
```

The tool resolves current `main` against the canonical HTTPS repository, asks GitHub's
fixed `release-image.yml` workflow endpoint for an already-successful
`Release SentryBox Image` push run for exactly that SHA, writes the same
root-private request used by the webhook, and starts
`sentrybox-deploy.service`. The deploy service independently fetches and
verifies canonical `main` and the immutable image before any runtime change. The
source is removed only after the successful deployment consumes its request;
it remains available after a failure so the operator can diagnose and retry.
Revoke the provider token immediately after that success and local removal. It
is not a scheduled rotation credential and has no recurring use; create a new
one-time token only when another fresh-host bootstrap is explicitly required.

The ingest fragment enforces a one-MiB edge limit and falls through to a fixed
`404` for UI, private API, exports, readiness, metrics, non-numeric project
paths, and every unlisted method. The deployment fragment applies the same body
limit and exposes no health or application route.

## Configure Cloudflare Tunnel

Add exactly these public hostnames to the existing `home-dev` tunnel:

```text
errors.intexuraos.cloud        -> http://localhost:80
errors-deploy.intexuraos.cloud -> http://localhost:80
```

Keep the tunnel credential in its dedicated credential file; never place it in
a unit `ExecStart`, process argument, repository file, or diagnostic output.
Credential rotation is covered by `credential-rotation.md`.

Configure an edge rule for `errors.intexuraos.cloud` that permits only the
documented methods and anchored envelope/liveness paths. Configure a per-source
rate rule no looser than the SentryBox source budget and verify its response
does not expose a project or key. Caddy and the application remain the final
enforcement points even when an edge rule is absent or misconfigured.

These layers intentionally have distinct denial responses. A request sent
directly to the Caddy origin for an unlisted path or method receives the fixed
`404` described above. From the public Internet, the live Cloudflare edge rule
rejects unlisted `errors.intexuraos.cloud` traffic before it reaches Caddy and
returns `403`. The deployment hostname has no equivalent edge allowlist, so its
unlisted routes continue to reach Caddy and return `404`.

## Configure private Tailscale access

With SentryBox healthy on `127.0.0.1:8141`, run:

```bash
sudo /opt/sentrybox-control/current/deploy/home-dev/configure-tailscale.sh
```

This applies only:

```text
tailscale serve --bg --https=8443 http://127.0.0.1:8141
```

It verifies that Tailscale is online, reads back the persisted Serve mapping,
derives the current peer hostname from `Self.DNSName`, and probes private
readiness. If `ERROR_HUB_PRIVATE_ORIGIN` is present, the script also requires
that exact origin to match the current peer. It refuses to overwrite a
conflicting port `8443` mapping and rolls back a newly created mapping when
structural validation or readiness fails. Preserve existing Serve entries;
inspect the result after setup:

```bash
sudo tailscale serve status --json
```

Do not expose port `8141` through Caddy, Cloudflare, UFW, or a host-wide bind.

## Reach private Tailscale Serve from Code Workers

Workers without a Tailscale interface can use the optional Home Dev relay.
It accepts IPv6 TCP only at `[fd00:172:28::1]:8443` on `code-worker-br`, the
bridge for `code-worker-net`. The IntexuraOS host firewall must restrict this
ingress to the worker subnet `fd00:172:28::/64`. Install and validate that
firewall and the worker network before
[enabling the relay](protected-control.md#enable-the-worker-relay).

The relay forwards TCP to the local node's MagicDNS name on port `8443`.
The configured private HTTPS origin still supplies the request hostname,
TLS server name, and certificate name. The worker changes only its connection
address. For example, from a disposable worker on `code-worker-net`:

```bash
curl --fail --silent --show-error --max-time 8 \
  --connect-to 'example-node.example-tailnet.ts.net:8443:[fd00:172:28::1]:8443' \
  https://example-node.example-tailnet.ts.net:8443/health/ready
```

Use the real private origin in both hostname positions. Confirm the strict
issue and latest-event MCP reads with the deployed worker image. Repeat
connection denial checks through IPv4 and from outside the worker bridge.
Keep SentryBox on its existing Compose network and leave Tailscale Serve on
the Tailscale interface.

## Boundary acceptance

From a normal Internet client, verify:

```bash
curl -fsS https://errors.intexuraos.cloud/health/live
curl -sS -o /dev/null -w '%{http_code}\n' \
  https://errors.intexuraos.cloud/api/issues                 # 403 (Cloudflare edge)
curl -sS -o /dev/null -w '%{http_code}\n' -X GET \
  https://errors.intexuraos.cloud/api/1/envelope/            # 403 (Cloudflare edge)
curl -sS -o /dev/null -w '%{http_code}\n' \
  https://errors-deploy.intexuraos.cloud/health/live         # 404
curl -sS -o /dev/null -w '%{http_code}\n' -X GET \
  https://errors-deploy.intexuraos.cloud/github/workflow-run # 404
curl -sS -D - -o /dev/null -X POST \
  -H 'Content-Type: application/json' --data '{}' \
  https://errors-deploy.intexuraos.cloud/github/workflow-run
# 400 plus x-sentrybox-deploy-handler: workflow-run-v1; no deployment starts
```

Use a disposable key for CORS and body-size tests. A configured browser origin
must receive a successful preflight, a lookalike origin must receive `400`, and
a body over one MiB must be rejected without an event or outbox row.

From an allowed tailnet client, open the private origin and verify the UI,
private API, export, readiness, and metrics. From a client outside the tailnet,
the private MagicDNS/Tailscale address must not be reachable.

For installations using the worker relay, also complete the disposable-worker
checks in [Reach private Tailscale Serve from Code Workers](#reach-private-tailscale-serve-from-code-workers).

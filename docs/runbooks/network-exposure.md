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

## Install the Caddy fragments

The canonical fragments are:

- `deploy/home-dev/caddy-sentrybox.caddy`
- `deploy/home-dev/caddy-sentrybox-deploy.caddy`

Installation copies those canonical sources to these live paths:

- `/etc/caddy/Caddyfile.d/sentrybox.caddy`
- `/etc/caddy/Caddyfile.d/sentrybox-deploy.caddy`

The Home Dev Caddyfile imports `/etc/caddy/Caddyfile.d/*.caddy`; it does not
import either source directly from the deployment checkout. When
`sentrybox-deploy.service` runs the deployment transaction, only the live
`sentrybox.caddy` ingest fragment is temporarily replaced by the maintenance
route and then restored from `deploy/home-dev/caddy-sentrybox.caddy`. The live
deploy callback fragment remains unchanged.

From the repository root, run the canonical installer as root with the actual
private tailnet origin:

```bash
sudo ./deploy/home-dev/install.sh \
  --private-origin "https://<home-dev-tailnet-name>:8443"
```

Then verify the installed live fragments before every reload:

```bash
sudo test -f /etc/caddy/Caddyfile.d/sentrybox.caddy
sudo test -f /etc/caddy/Caddyfile.d/sentrybox-deploy.caddy
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

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

## Configure private Tailscale access

With SentryBox healthy on `127.0.0.1:8141`, run:

```bash
sudo /home/pbuchman/deploy/sentrybox/deploy/home-dev/configure-tailscale.sh
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

## Boundary acceptance

From a normal Internet client, verify:

```bash
curl -fsS https://errors.intexuraos.cloud/health/live
curl -sS -o /dev/null -w '%{http_code}\n' \
  https://errors.intexuraos.cloud/api/issues                 # 404
curl -sS -o /dev/null -w '%{http_code}\n' -X GET \
  https://errors.intexuraos.cloud/api/1/envelope/            # 404
curl -sS -o /dev/null -w '%{http_code}\n' \
  https://errors-deploy.intexuraos.cloud/health/live         # 404
curl -sS -o /dev/null -w '%{http_code}\n' -X GET \
  https://errors-deploy.intexuraos.cloud/github/workflow-run # 404
```

Use a disposable key for CORS and body-size tests. A configured browser origin
must receive a successful preflight, a lookalike origin must receive `400`, and
a body over one MiB must be rejected without an event or outbox row.

From an allowed tailnet client, open the private origin and verify the UI,
private API, export, readiness, and metrics. From a client outside the tailnet,
the private MagicDNS/Tailscale address must not be reachable.

Finally start one disposable real Code Worker and request the private MCP
health/capability endpoint over port `8443`. Do not attach SentryBox to
`code-worker-net`. Add a narrow host-gateway route only if that real probe proves
the normal tailnet route unavailable, then repeat the denial checks before
keeping it.

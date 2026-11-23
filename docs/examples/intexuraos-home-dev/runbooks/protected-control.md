# Install and migrate protected Home Dev control

Home Dev installs privileged control under
`/opt/sentrybox-control/releases/<reviewed-commit>/deploy/home-dev`.
The root-owned `current` symlink selects the installed control release. The
GitHub workflow advances the application image when the request names the
current canonical `main` commit. It uses the selected control release for
Compose, database helpers, systemd and Caddy. An operator installs a new control
release explicitly after review.

Home Dev requires the Ubuntu `acl` package. The webhook validates the
systemd credential directory and its file ACL when the kernel represents
the service's private read permission as a group mask.

The application digest and source SHA remain in
`/var/lib/sentrybox-deploy/{current,previous}.env`. Rolling back the application
uses the protected Compose and database helpers with the prior recorded
digest. Installing an earlier protected control release uses the same
installation procedure and keeps the current application digest.

## Stage an exact reviewed release

Review the exact SentryBox commit, including the complete `deploy/home-dev`
tree. Set `control_sha` to the reviewed 40-character commit. For a regular
rollout, use a commit reachable from the public canonical `main` branch. The
bootstrap fetches the public URL with root-owned temporary Git metadata.

For a reviewed local commit awaiting merge, export a Git bundle as the
operator. Use a clean, reviewed checkout with its HEAD at the exact commit.
Record the bundle SHA-256 from this trusted session. The staging command
verifies the complete bundle and expected commit before exporting assets.

```bash
test "$(git rev-parse HEAD)" = "${control_sha}"
test -z "$(git status --porcelain)"
bundle_directory="$(mktemp -d)"
bundle="${bundle_directory}/reviewed-control.bundle"
git bundle create "${bundle}" HEAD
bundle_sha="$(sha256sum "${bundle}")"
bundle_sha="${bundle_sha%% *}"
```

Run the staging block from Bash on Home Dev. Leave `bundle` and `bundle_sha`
unset for a canonical-main install. For the local alternative, the operator's
shell opens the bundle and streams it to the staging block on stdin. Root
validates the selected artifact inside a protected directory.

```bash
stage_sentrybox_control() (
set -euo pipefail
umask 022
cd /
sha="$1"
[[ "$sha" =~ ^[0-9a-f]{40}$ ]]
control=/opt/sentrybox-control
for directory in /opt "$control" "$control/releases"; do
  if [[ "$directory" != /opt && ! -e "$directory" && ! -L "$directory" ]]; then
    mkdir -m 0755 "$directory"
  fi
  [[ -d "$directory" && ! -L "$directory" ]]
  [[ "$(stat -c '%u:%g:%a' "$directory")" == '0:0:755' ]]
done

staging="$(mktemp -d "$control/staging.XXXXXX")"
trap 'rm -rf -- "$staging"' EXIT
git init --quiet --bare --template= "$staging/git"
archive_sha="${2:-}"
if [[ -n "$archive_sha" ]]; then
  [[ "$archive_sha" =~ ^[0-9a-f]{64}$ ]]
  head -c 33554433 >"$staging/reviewed.bundle"
  [[ "$(stat -c '%s' "$staging/reviewed.bundle")" -le 33554432 ]]
  actual_sha="$(sha256sum "$staging/reviewed.bundle")"
  [[ "${actual_sha%% *}" == "$archive_sha" ]]
  git --git-dir="$staging/git" fetch --quiet --no-tags \
    "$staging/reviewed.bundle" HEAD:refs/heads/reviewed
  [[ "$(git --git-dir="$staging/git" rev-parse refs/heads/reviewed)" == "$sha" ]]
else
  git --git-dir="$staging/git" fetch --quiet --no-tags \
    https://github.com/pbuchman/sentrybox.git refs/heads/main:refs/heads/main
  git --git-dir="$staging/git" merge-base --is-ancestor "$sha" refs/heads/main
fi
[[ "$(git --git-dir="$staging/git" cat-file -t "$sha")" == commit ]]
git --git-dir="$staging/git" ls-tree -r "$sha" -- deploy/home-dev \
  | awk '$1 != "100644" && $1 != "100755" { invalid=1 } END { exit invalid }'
mkdir -m 0755 "$staging/release"
git --git-dir="$staging/git" archive --format=tar "$sha" deploy/home-dev \
  | tar --extract --file=- --directory="$staging/release" --no-same-owner \
      --no-same-permissions
[[ -z "$(find "$staging/release" \
  \( ! -user root -o ! -group root -o -perm /022 -o \( ! -type f -a ! -type d \) \) \
  -print -quit)" ]]
destination="$control/releases/$sha"
if [[ -e "$destination" || -L "$destination" ]]; then
  [[ -d "$destination" && ! -L "$destination" ]]
  diff -qr --no-dereference "$staging/release" "$destination"
else
  mv -T "$staging/release" "$destination"
fi
test -x "$destination/deploy/home-dev/install.sh"
)

sudo /usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin HOME=/root \
  GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0 \
  /usr/bin/bash --noprofile --norc -c \
  "$(declare -f stage_sentrybox_control)"$'\nstage_sentrybox_control "$@"' _ \
  "${control_sha}" "${bundle_sha:-}" <"${bundle:-/dev/null}"
```

## Install for the first time or update protected control

For a fresh setup, create the runtime credential using the
[network runbook](network-exposure.md). Set `private_origin` to the configured
Tailscale HTTPS origin. Run the installer from the staged release.

```bash
sudo "/opt/sentrybox-control/releases/${control_sha}/deploy/home-dev/install.sh" \
  --private-origin "${private_origin}"
sudo readlink /opt/sentrybox-control/current
sudo systemctl show sentrybox.service --property=WorkingDirectory --property=ExecStop
```

The selector must read `releases/<reviewed-commit>`. Verify the systemd stop
command uses `/opt/sentrybox-control/current/deploy/home-dev/runtime.sh`.
For a control upgrade on a running host, reconcile the container with the new
protected Compose project by running `sudo systemctl reload sentrybox.service`.
The installer restarts the webhook if it was active. Pass `--start-webhook`
to enable a configured webhook when it was previously stopped.

## Enable the worker relay

This option requires the exact Code Worker bridge, the active
`intexuraos-iptables.service` host firewall, systemd 255, and working
[private Tailscale Serve](network-exposure.md#configure-private-tailscale-access).
Pass the configured private HTTPS origin on port `8443`.

```bash
sudo "/opt/sentrybox-control/releases/${control_sha}/deploy/home-dev/install.sh" \
  --private-origin "${private_origin}" --enable-worker-relay
sudo systemctl is-enabled sentrybox-worker-relay.socket
sudo systemctl is-active sentrybox-worker-relay.socket
sudo stat -c '%a:%U:%G:%h' /etc/sentrybox/worker-relay.env
```

The file metadata must read `600:root:root:1`. The installer compares the
configured origin with the online node's `Self.DNSName` and stages only the
verified hostname and port as `SENTRYBOX_WORKER_RELAY_TARGET`. The proxy starts
on demand from the socket. Loss of the firewall or bridge stops both units and
closes existing relay connections. An enabled socket rearms after the bridge
and firewall are available and the exact IPv6 gateway is ready. Subsequent
installs refresh an enabled relay even when the flag is omitted. Installations
without the worker network can use the ordinary install command.

## Roll back to control without the worker relay

Pause use of the relay in the worker runtime before removing it. When the
earlier control release predates these units, stop both units and disable
socket activation before running its installer:

```bash
sudo systemctl stop sentrybox-worker-relay.socket sentrybox-worker-relay.service
sudo systemctl disable sentrybox-worker-relay.socket
sudo rm -f /etc/systemd/system/sentrybox-worker-relay.socket \
  /etc/systemd/system/sentrybox-worker-relay.service /etc/sentrybox/worker-relay.env
sudo systemctl daemon-reload
```

Confirm port `8443` no longer has a listener on the worker bridge with
`sudo ss -H -6 -ltn 'sport = :8443'`. Then run the ordinary install command
from the earlier reviewed release and verify private Tailscale readiness and
public ingest.

## Migrate a legacy installation

Schedule a brief SentryBox outage. Stage the reviewed release before stopping
anything. Verify the existing digest, readiness and retained snapshot, then
record whether the webhook is enabled. Confirm the legacy `data`, `backups`
and `env` entries are on the same filesystem as `/var/lib`. The legacy webhook credential must be on the same filesystem
as `/etc`. Use
`stat -c '%d' PATH` on each source and destination parent. Resolve a filesystem
mismatch before stopping services.

Prevent legacy jobs from starting after a reboot by disabling the runtime,
webhook and timers before stopping them. Stop the webhook and operational timers. Wait for
any running deploy, bootstrap, backup, monitor and restore jobs to finish.
Ensure the timers and webhook remain stopped for the migration.

```bash
sudo systemctl disable sentrybox.service sentrybox-deploy-webhook.service \
  sentrybox-backup.timer sentrybox-monitor.timer sentrybox-restore-test.timer
sudo systemctl stop sentrybox-deploy-webhook.service sentrybox-backup.timer \
  sentrybox-monitor.timer sentrybox-restore-test.timer
sudo systemctl show --property=ActiveState sentrybox-deploy.service \
  sentrybox-deploy-bootstrap.service sentrybox-backup.service \
  sentrybox-monitor.service sentrybox-restore-test.service
```

Proceed once the job units report `inactive` or `failed`. Add a temporary runtime
drop-in that clears the legacy root stop command before stopping the application
unit. Stop the running container by its verified Compose labels.

```bash
(
set -euo pipefail
sudo install -d -m 0755 /run/systemd/system/sentrybox.service.d
printf '[Service]\nExecStop=\nExecStopPost=\n' | sudo tee \
  /run/systemd/system/sentrybox.service.d/90-protected-control-migration.conf >/dev/null
sudo systemctl daemon-reload
test "$(systemctl show sentrybox.service --property=ExecStop --value)" = ""
test "$(systemctl show sentrybox.service --property=ExecStopPost --value)" = ""
sudo systemctl stop sentrybox.service

container_id="$(sudo docker ps --quiet \
  --filter label=com.docker.compose.project=sentrybox \
  --filter label=com.docker.compose.service=sentrybox)"
[[ "$container_id" =~ ^[0-9a-f]{12,64}$ ]]
sudo docker stop --time 30 "$container_id"
)
```

Run the protected installer. Include `--start-webhook` if the prior deployment
had an active webhook. The installer moves entire directories by same-filesystem
rename, preserving data, SQLite sidecars and backups. It moves the service and
webhook credentials without printing their contents. It prepares a protected
copy of the tunnel token while the legacy unit can still restart. Once the
protected unit is loaded and application verification passes, the installer
removes the old token. It retains protected
deployment state and installs the new paths before restarting the runtime and
scheduled jobs.

```bash
(
set -euo pipefail
sudo "/opt/sentrybox-control/releases/${control_sha}/deploy/home-dev/install.sh" \
  --private-origin "${private_origin}" --migrate --start-webhook
sudo rm -- /run/systemd/system/sentrybox.service.d/90-protected-control-migration.conf
sudo systemctl daemon-reload
sudo systemctl show sentrybox.service --property=WorkingDirectory --property=ExecStop
sudo systemctl is-active sentrybox.service sentrybox-deploy-webhook.service \
  sentrybox-deploy-request.socket sentrybox-backup.timer sentrybox-monitor.timer \
  sentrybox-restore-test.timer
)
```

If interrupted before activation, the installer can resume when each entry
exists only at its legacy location or only at its protected location. If
activation has already published the new units, finish with the same
protected release and the ordinary install command. Keep the legacy stop
override until the protected unit has been published. Preserve the existing
app digest, current state, migrated paths and staging evidence when diagnosing
a failure. Recover by rerunning the reviewed release or, after a subsequent
control upgrade, by installing the previous reviewed control release.

Confirm that the Compose container uses the recorded digest, its data bind
resolves to `/var/lib/sentrybox/data`, and private readiness and public ingest
respond as expected. For an installed cloudflared service, the installer
publishes its protected credential path for the next start. Verify the
existing shared tunnel and restart it only within the agreed service window.

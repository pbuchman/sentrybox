#!/usr/bin/env bash
set -euo pipefail

readonly tailscale_bin="${ERROR_HUB_TAILSCALE_BIN:-tailscale}"
readonly sudo_bin="${ERROR_HUB_SUDO_BIN:-sudo}"
readonly node_bin="${ERROR_HUB_NODE_BIN:-node}"
readonly curl_bin="${ERROR_HUB_CURL_BIN:-curl}"
readonly private_origin="https://home-dev.taild6ad57.ts.net:8443"

for executable in "${tailscale_bin}" "${sudo_bin}" "${node_bin}" "${curl_bin}"; do
  if ! command -v "${executable}" >/dev/null 2>&1; then
    printf 'Required executable is unavailable: %s\n' "${executable}" >&2
    exit 1
  fi
done

status_json="$(${tailscale_bin} status --json)"
if ! printf '%s' "${status_json}" | "${node_bin}" -e '
  let body = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { body += chunk; });
  process.stdin.on("end", () => {
    const status = JSON.parse(body);
    if (status.BackendState !== "Running" || status.Self?.Online !== true) {
      process.exitCode = 1;
    }
  });
'; then
  printf 'Tailscale must be running and the Home Dev peer must be online.\n' >&2
  exit 1
fi

"${sudo_bin}" "${tailscale_bin}" serve --bg --https=8443 http://127.0.0.1:8141 >/dev/null

serve_json="$(${sudo_bin} "${tailscale_bin}" serve status --json)"
if ! printf '%s' "${serve_json}" | "${node_bin}" -e '
  let body = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { body += chunk; });
  process.stdin.on("end", () => {
    const serialized = JSON.stringify(JSON.parse(body));
    if (!serialized.includes(":8443") || !serialized.includes("http://127.0.0.1:8141")) {
      process.exitCode = 1;
    }
  });
'; then
  printf 'Tailscale Serve did not retain the required private proxy.\n' >&2
  exit 1
fi

"${curl_bin}" --fail --silent --show-error --connect-timeout 2 --max-time 5 \
  https://home-dev.taild6ad57.ts.net:8443/health/ready >/dev/null

printf 'Error Hub private Tailscale endpoint is ready at %s.\n' "${private_origin}"

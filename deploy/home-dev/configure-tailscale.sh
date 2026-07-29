#!/usr/bin/env bash
set -euo pipefail

readonly tailscale_bin="${ERROR_HUB_TAILSCALE_BIN:-tailscale}"
readonly sudo_bin="${ERROR_HUB_SUDO_BIN:-sudo}"
readonly node_bin="${ERROR_HUB_NODE_BIN:-node}"
readonly curl_bin="${ERROR_HUB_CURL_BIN:-curl}"
readonly serve_port="8443"
readonly proxy_target="http://127.0.0.1:8141"
readonly configured_private_origin="${ERROR_HUB_PRIVATE_ORIGIN:-}"

for executable in "${tailscale_bin}" "${sudo_bin}" "${node_bin}" "${curl_bin}"; do
  if ! command -v "${executable}" >/dev/null 2>&1; then
    printf 'Required executable is unavailable: %s\n' "${executable}" >&2
    exit 1
  fi
done

status_json="$(${tailscale_bin} status --json)"
if ! dns_name="$(printf '%s' "${status_json}" | "${node_bin}" -e '
  let body = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { body += chunk; });
  process.stdin.on("end", () => {
    const status = JSON.parse(body);
    const rawDnsName = status.Self?.DNSName;
    if (
      status.BackendState !== "Running" ||
      status.Self?.Online !== true ||
      typeof rawDnsName !== "string"
    ) {
      process.exitCode = 1;
      return;
    }
    const dnsName = rawDnsName.replace(/[.]$/u, "").toLowerCase();
    const label = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
    const hostname = new RegExp("^(?:" + label + "[.])+" + label + "$", "u");
    if (!hostname.test(dnsName) || !dnsName.endsWith(".ts.net")) {
      process.exitCode = 1;
      return;
    }
    process.stdout.write(dnsName);
  });
')"; then
  printf 'Tailscale must be running with an online peer and a valid ts.net DNS name.\n' >&2
  exit 1
fi

readonly dns_name
readonly private_origin="https://${dns_name}:${serve_port}"

if [[ -n "${configured_private_origin}" ]]; then
  if ! canonical_configured_origin="$("${node_bin}" -e '
    const value = process.argv[1];
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.port !== "8443" ||
      url.username.length > 0 ||
      url.password.length > 0 ||
      url.pathname !== "/" ||
      url.search.length > 0 ||
      url.hash.length > 0 ||
      url.origin !== value
    ) {
      process.exit(1);
    }
    process.stdout.write(url.origin);
  ' "${configured_private_origin}")"; then
    printf 'ERROR_HUB_PRIVATE_ORIGIN must be an exact HTTPS origin on port 8443.\n' >&2
    exit 1
  fi
  if [[ "${canonical_configured_origin}" != "${private_origin}" ]]; then
    printf 'ERROR_HUB_PRIVATE_ORIGIN does not match the current Tailscale peer.\n' >&2
    exit 1
  fi
fi

classify_serve_mapping() {
  local serve_json="$1"
  printf '%s' "${serve_json}" | "${node_bin}" -e '
    let body = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { body += chunk; });
    process.stdin.on("end", () => {
      const status = JSON.parse(body);
      const dnsName = process.argv[1];
      const port = process.argv[2];
      const proxyTarget = process.argv[3];
      const expectedWebKey = dnsName + ":" + port;
      const isRecord = (value) =>
        value !== null && typeof value === "object" && !Array.isArray(value);
      const own = (value, key) =>
        isRecord(value) && Object.prototype.hasOwnProperty.call(value, key);
      const tcp = isRecord(status.TCP) ? status.TCP[port] : undefined;
      const webMap = isRecord(status.Web) ? status.Web : {};
      const web = webMap[expectedWebKey];
      const handlers = isRecord(web) ? web.Handlers : undefined;
      const rootHandler = isRecord(handlers) ? handlers["/"] : undefined;
      const portWebKeys = Object.keys(webMap).filter((key) =>
        key.endsWith(":" + port),
      );
      const exact =
        isRecord(tcp) &&
        Object.keys(tcp).length === 1 &&
        tcp.HTTPS === true &&
        portWebKeys.length === 1 &&
        portWebKeys[0] === expectedWebKey &&
        isRecord(web) &&
        Object.keys(web).length === 1 &&
        isRecord(handlers) &&
        Object.keys(handlers).length === 1 &&
        isRecord(rootHandler) &&
        Object.keys(rootHandler).length === 1 &&
        rootHandler.Proxy === proxyTarget;
      const ownsPort = own(status.TCP, port) || portWebKeys.length > 0;
      process.stdout.write(exact ? "exact" : ownsPort ? "conflict" : "absent");
    });
  ' "${dns_name}" "${serve_port}" "${proxy_target}"
}

mapping_changed=false
rollback_on_failure() {
  local exit_status="$?"
  trap - EXIT
  if [[ "${mapping_changed}" == "true" ]]; then
    if ! "${sudo_bin}" "${tailscale_bin}" serve --yes "--https=${serve_port}" off >/dev/null; then
      printf 'Failed to roll back the new Tailscale Serve mapping.\n' >&2
    fi
  fi
  exit "${exit_status}"
}
trap rollback_on_failure EXIT

serve_json="$(${sudo_bin} "${tailscale_bin}" serve status --json)"
mapping_state="$(classify_serve_mapping "${serve_json}")"
if [[ "${mapping_state}" == "conflict" ]]; then
  printf 'Tailscale Serve port %s already has a conflicting mapping.\n' "${serve_port}" >&2
  exit 1
fi

if [[ "${mapping_state}" == "absent" ]]; then
  mapping_changed=true
  "${sudo_bin}" "${tailscale_bin}" serve --yes --bg "--https=${serve_port}" "${proxy_target}" >/dev/null
fi

serve_json="$(${sudo_bin} "${tailscale_bin}" serve status --json)"
if [[ "$(classify_serve_mapping "${serve_json}")" != "exact" ]]; then
  printf 'Tailscale Serve did not retain the required private proxy.\n' >&2
  exit 1
fi

if ! "${curl_bin}" --fail --silent --show-error --connect-timeout 2 --max-time 5 \
  "${private_origin}/health/ready" >/dev/null; then
  printf 'SentryBox private Tailscale readiness probe failed.\n' >&2
  exit 1
fi

mapping_changed=false
trap - EXIT
printf 'SentryBox private Tailscale endpoint is ready at %s.\n' "${private_origin}"

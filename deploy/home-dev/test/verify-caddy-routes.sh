#!/usr/bin/env bash
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
readonly repository_root
readonly caddy_image="caddy:2.10.2-alpine@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d"
readonly container_name="error-hub-caddy-contract-$$-${RANDOM}"
readonly caddyfile="${repository_root}/deploy/home-dev/test/Caddyfile"
oversized_body=""

for executable in docker curl; do
  if ! command -v "${executable}" >/dev/null 2>&1; then
    printf 'Required executable is unavailable: %s\n' "${executable}" >&2
    exit 1
  fi
done

cleanup() {
  docker rm --force "${container_name}" >/dev/null 2>&1 || true
  if [[ -n "${oversized_body}" ]]; then
    rm -f "${oversized_body}"
  fi
}
trap cleanup EXIT INT TERM

docker run --rm \
  --volume "${repository_root}/deploy/home-dev:/config:ro" \
  --volume "${caddyfile}:/etc/caddy/Caddyfile:ro" \
  "${caddy_image}" \
  caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null

docker run --detach \
  --name "${container_name}" \
  --publish 127.0.0.1::80 \
  --volume "${repository_root}/deploy/home-dev:/config:ro" \
  --volume "${caddyfile}:/etc/caddy/Caddyfile:ro" \
  "${caddy_image}" \
  sh -c 'nc -lk -p 8140 -e /config/test/read-http-request.sh &
    nc -lk -p 9003 -e /config/test/read-http-request.sh &
    exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile' >/dev/null

port_mapping="$(docker port "${container_name}" 80/tcp)"
readonly port_mapping
host_port="${port_mapping##*:}"
readonly host_port
if [[ ! "${host_port}" =~ ^[0-9]+$ ]]; then
  printf 'Could not determine the Caddy test port from: %s\n' "${port_mapping}" >&2
  exit 1
fi

http_status() {
  local method="$1"
  local host="$2"
  local path="$3"
  shift 3
  local status
  if ! status="$(curl --silent --output /dev/null --write-out '%{http_code}' \
    --max-time 5 --request "${method}" --header "Host: ${host}" "$@" \
    "http://127.0.0.1:${host_port}${path}")"; then
    status="${status:-curl-error}"
  fi
  printf '%s' "${status}"
}

assert_status() {
  local expected="$1"
  local method="$2"
  local host="$3"
  local path="$4"
  shift 4
  local actual
  actual="$(http_status "${method}" "${host}" "${path}" "$@")"
  if [[ "${actual}" != "${expected}" ]]; then
    printf 'Expected %s for %s %s%s, received %s.\n' \
      "${expected}" "${method}" "${host}" "${path}" "${actual}" >&2
    return 1
  fi
}

caddy_ready=false
for _attempt in {1..40}; do
  if [[ "$(http_status GET errors.intexuraos.cloud /not-exposed)" == "404" ]]; then
    caddy_ready=true
    break
  fi
  sleep 0.25
done
if [[ "${caddy_ready}" != "true" ]]; then
  docker logs "${container_name}" >&2
  printf 'Caddy did not become ready for route contract checks.\n' >&2
  exit 1
fi

assert_status 204 POST errors.intexuraos.cloud /api/1/envelope/
assert_status 204 OPTIONS errors.intexuraos.cloud /api/42/envelope/
assert_status 204 GET errors.intexuraos.cloud /health/live
assert_status 404 GET errors.intexuraos.cloud /api/issues
assert_status 404 GET errors.intexuraos.cloud /api/1/envelope/
assert_status 404 POST errors.intexuraos.cloud /health/live
assert_status 404 GET errors.intexuraos.cloud /health/ready
assert_status 404 GET errors.intexuraos.cloud /metrics
assert_status 404 POST errors.intexuraos.cloud /api/1/envelope

assert_status 204 POST errors-deploy.intexuraos.cloud /github/workflow-run
assert_status 404 GET errors-deploy.intexuraos.cloud /github/workflow-run
assert_status 404 POST errors-deploy.intexuraos.cloud /github/workflow-run/
assert_status 404 GET errors-deploy.intexuraos.cloud /health/live
assert_status 404 POST errors-deploy.intexuraos.cloud /api/1/envelope/

oversized_body="$(mktemp "${TMPDIR:-/tmp}/error-hub-caddy-body.XXXXXX")"
dd if=/dev/zero of="${oversized_body}" bs=1048577 count=1 2>/dev/null
assert_status 413 POST errors.intexuraos.cloud /api/1/envelope/ \
  --header 'Content-Type: application/x-sentry-envelope' \
  --data-binary "@${oversized_body}"
assert_status 413 POST errors-deploy.intexuraos.cloud /github/workflow-run \
  --header 'Content-Type: application/json' \
  --data-binary "@${oversized_body}"

printf 'Pinned Caddy validation and public route matrix passed.\n'

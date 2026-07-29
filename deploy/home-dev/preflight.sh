#!/usr/bin/env bash
set -euo pipefail

script_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly script_directory
# shellcheck source=deploy/home-dev/common.sh
source "${script_directory}/common.sh"
readonly database_operations="${script_directory}/database-operations.mjs"

readonly candidate_image="${1:-}"
error_hub_require_immutable_image "${candidate_image}"

for executable in docker df ss stat; do
  error_hub_require_command "${executable}"
done

runtime_uid="${ERROR_HUB_RUNTIME_UID:-1000}"
runtime_gid="${ERROR_HUB_RUNTIME_GID:-1000}"
readonly runtime_uid runtime_gid
if [[ ! "${runtime_uid}" =~ ^[1-9][0-9]*$ \
  || ! "${runtime_gid}" =~ ^[1-9][0-9]*$ ]]; then
  printf 'Preflight requires a numeric non-root runtime UID and GID.\n' >&2
  exit 1
fi

for required_path in \
  "${error_hub_checkout}" \
  "${error_hub_service_root}" \
  "${error_hub_data_directory}" \
  "${error_hub_environment_file}" \
  "${error_hub_runtime_environment_file}" \
  "${error_hub_compose_file}" \
  "${error_hub_project_config}"; do
  if [[ ! -e "${required_path}" ]]; then
    printf 'Required Home Dev path is missing: %s\n' "${required_path}" >&2
    exit 1
  fi
done

error_hub_require_runtime_environment

error_hub_require_free_space "${error_hub_service_root}"

write_probe="${error_hub_data_directory}/.preflight-write.$$"
trap 'rm -f "${write_probe}"' EXIT
umask 077
: >"${write_probe}"
rm -f "${write_probe}"

docker info >/dev/null
docker compose version >/dev/null

listener_output="$(ss -H -ltn 2>/dev/null || true)"
for port in 8140 8141; do
  if printf '%s\n' "${listener_output}" | awk -v port=":${port}" '$4 ~ port "$" { found=1 } END { exit(found ? 0 : 1) }'; then
    container_id="$(
      ERROR_HUB_IMAGE="${candidate_image}" \
        ERROR_HUB_PRIVATE_ORIGIN="${ERROR_HUB_PRIVATE_ORIGIN:-https://preflight.invalid}" \
        docker compose --file "${error_hub_compose_file}" ps -q sentrybox
    )"
    if [[ -z "${container_id}" ]]; then
      printf 'Port %s is occupied by a process outside SentryBox Compose.\n' "${port}" >&2
      exit 1
    fi
    bindings="$(docker inspect --format '{{json .HostConfig.PortBindings}}' "${container_id}")"
    if [[ "${bindings}" != *"\"HostIp\":\"127.0.0.1\""* \
      || "${bindings}" != *"\"HostPort\":\"${port}\""* ]]; then
      printf 'Port %s is not owned by the loopback-only SentryBox container.\n' "${port}" >&2
      exit 1
    fi
  fi
done

container_write_probe="${error_hub_data_directory}/.container-preflight"
rm -f "${container_write_probe}"
docker run --rm --interactive \
  --user "${runtime_uid}:${runtime_gid}" \
  --network none \
  --read-only \
  --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --tmpfs /tmp:size=16m,mode=1777 \
  --label sentrybox-check=runtime-write \
  --mount "type=bind,src=${error_hub_data_directory},dst=/data" \
  --entrypoint node \
  "${candidate_image}" \
  --input-type=module - runtime-write \
  <"${database_operations}" >/dev/null
rm -f "${container_write_probe}"

docker run --rm \
  --read-only \
  --tmpfs /tmp:size=16m,mode=1777 \
  --mount "type=bind,src=${error_hub_project_config},dst=/run/config/projects.json,readonly" \
  --entrypoint node \
  "${candidate_image}" \
  scripts/admin/validate-project-config.mjs \
  --config /run/config/projects.json >/dev/null

error_hub_recover_synthetic_public_check "${candidate_image}"
if [[ -f "${error_hub_database}" ]]; then
  docker run --rm --interactive \
    --label sentrybox-check=preflight-integrity \
    --user "${runtime_uid}:${runtime_gid}" \
    --network none \
    --read-only \
    --cap-drop ALL \
    --security-opt no-new-privileges:true \
    --tmpfs /tmp:size=16m,mode=1777 \
    --mount "type=bind,src=${error_hub_data_directory},dst=/data" \
    --entrypoint node \
    "${candidate_image}" \
    --input-type=module - preflight \
    <"${database_operations}" >/dev/null
fi

printf 'SentryBox preflight passed.\n'

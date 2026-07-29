#!/usr/bin/env bash
set -euo pipefail

script_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly script_directory
# shellcheck source=deploy/home-dev/common.sh
source "${script_directory}/common.sh"
readonly database_operations="${script_directory}/database-operations.mjs"

for executable in docker curl jq stat; do
  error_hub_require_command "${executable}"
done

error_hub_read_state "${error_hub_previous_state}"
readonly previous_image="${ERROR_HUB_STATE_IMAGE}"
readonly previous_origin="${ERROR_HUB_STATE_PRIVATE_ORIGIN}"
readonly previous_sha="${ERROR_HUB_STATE_SHA}"

restart_status=0
error_hub_compose_up "${previous_image}" "${previous_origin}" || restart_status=$?

integrity_status=0
if [[ -f "${error_hub_database}" ]]; then
  docker run --rm --interactive \
    --read-only \
    --tmpfs /tmp:size=16m,mode=1777 \
    --label sentrybox-check=rollback-integrity \
    --mount "type=bind,src=${error_hub_data_directory},dst=/data,readonly" \
    --entrypoint node \
    "${previous_image}" \
    --input-type=module - rollback-integrity \
    <"${database_operations}" >/dev/null || integrity_status=$?
fi

if (( integrity_status != 0 )); then
  readonly backup_file="${error_hub_backup_directory}/predeploy.sqlite"
  if [[ ! -s "${backup_file}" || -L "${backup_file}" ]]; then
    printf 'Rollback database validation failed and no safe pre-deployment backup exists.\n' >&2
    exit 1
  fi
  ERROR_HUB_IMAGE="${previous_image}" \
    ERROR_HUB_PRIVATE_ORIGIN="${previous_origin}" \
    docker compose --file "${error_hub_compose_file}" stop --timeout 30 sentrybox >/dev/null || true
  restore_temporary="${error_hub_database}.restore.$$"
  trap 'rm -f "${restore_temporary}"' EXIT
  install -m 0600 "${backup_file}" "${restore_temporary}"
  mv -f "${restore_temporary}" "${error_hub_database}"
  restore_uid="${ERROR_HUB_RUNTIME_UID:-1000}"
  restore_gid="${ERROR_HUB_RUNTIME_GID:-1000}"
  if [[ ! "${restore_uid}" =~ ^[1-9][0-9]*$ || ! "${restore_gid}" =~ ^[1-9][0-9]*$ ]]; then
    printf 'Runtime UID and GID must be numeric and non-root.\n' >&2
    exit 1
  fi
  chown "${restore_uid}:${restore_gid}" "${error_hub_database}"
  rm -f "${error_hub_database}-wal" "${error_hub_database}-shm"
  error_hub_compose_up "${previous_image}" "${previous_origin}"
  restart_status=0
fi

if (( restart_status != 0 )); then
  printf 'Previous SentryBox image did not restart and the database remains valid; backup was not restored.\n' >&2
  exit "${restart_status}"
fi

error_hub_health_checks "${previous_origin}" "${previous_image}"
error_hub_write_state \
  "${error_hub_current_state}" \
  "${previous_image}" \
  "${previous_origin}" \
  "${previous_sha}"

printf 'SentryBox rolled back to %s.\n' "${previous_sha}"

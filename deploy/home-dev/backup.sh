#!/usr/bin/env bash
set -euo pipefail

script_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly script_directory
# shellcheck source=deploy/home-dev/common.sh
source "${script_directory}/common.sh"
readonly database_operations="${script_directory}/database-operations.mjs"

readonly mode="${1:-}"
error_hub_require_command docker
error_hub_require_command mktemp
readonly final_backup="${error_hub_backup_directory}/predeploy.sqlite"

require_safe_snapshot() {
  local snapshot="$1"
  local description="$2"
  local bytes links
  if [[ ! -f "${snapshot}" || -L "${snapshot}" || ! -s "${snapshot}" ]]; then
    printf '%s must be a non-empty regular file.\n' "${description}" >&2
    return 1
  fi
  bytes="$(stat -c '%s' "${snapshot}")"
  links="$(stat -c '%h' "${snapshot}")"
  if [[ "${links}" != "1" ]]; then
    printf '%s must be singly linked.\n' "${description}" >&2
    return 1
  fi
  if [[ ! "${bytes}" =~ ^[0-9]+$ ]] \
    || (( bytes > 5 * 1024 * 1024 * 1024 )); then
    printf '%s exceeds the 5 GiB staging limit.\n' "${description}" >&2
    return 1
  fi
}

finalize_retained_snapshot() (
  set -euo pipefail
  local image="$1"
  local temporary_retained retained_name
  error_hub_require_immutable_image "${image}"
  require_safe_snapshot "${final_backup}" "Pre-deployment backup"
  temporary_retained="$(
    mktemp "${error_hub_backup_directory}/.retained.sqlite.XXXXXX"
  )"
  retained_name="${temporary_retained##*/}"
  trap 'rm -f \
    "${temporary_retained}" \
    "${temporary_retained}-wal" \
    "${temporary_retained}-shm" \
    "${temporary_retained}-journal"' EXIT
  install -m 0600 "${final_backup}" "${temporary_retained}"
  docker run --rm --interactive \
    --user 0:0 \
    --network none \
    --read-only \
    --cap-drop ALL \
    --security-opt no-new-privileges:true \
    --tmpfs /tmp:size=32m,mode=1777 \
    --label sentrybox-check=retained-finalize \
    --mount "type=bind,src=${error_hub_backup_directory},dst=/retained" \
    --entrypoint node \
    "${image}" \
    --input-type=module - retained-finalize "/retained/${retained_name}" \
    <"${database_operations}"
  require_safe_snapshot "${temporary_retained}" "Retained backup"
  chmod 0600 "${temporary_retained}"
  mv -f "${temporary_retained}" "${final_backup}"
)

if [[ "${mode}" == "scheduled" ]]; then
  error_hub_require_command flock
  mkdir -p "$(dirname "${error_hub_lock_file}")"
  exec 9>"${error_hub_lock_file}"
  if ! flock -n 9; then
    printf 'Scheduled external backup is disabled/degraded, and deployment currently owns the backup snapshot.\n' >&2
    exit 1
  fi
  error_hub_read_state "${error_hub_current_state}"
  if ! require_safe_snapshot "${final_backup}" "Retained backup"; then
    printf 'Scheduled external backup is disabled/degraded, and no retained snapshot is available.\n' >&2
    exit 1
  fi
  finalize_retained_snapshot "${ERROR_HUB_STATE_IMAGE}"
  printf 'Scheduled external backup is disabled/degraded: no external Home Dev backup target is configured.\n' >&2
  exit 1
fi

if [[ "${mode}" == "retained-finalize" ]]; then
  finalize_retained_snapshot "${2:-}"
  printf '%s\n' "${final_backup}"
  exit 0
fi

if [[ "${mode}" != "predeploy" ]]; then
  printf 'Usage: backup.sh {predeploy|retained-finalize} IMMUTABLE_IMAGE_DIGEST, or backup.sh scheduled\n' >&2
  exit 2
fi

readonly image="${2:-}"
error_hub_require_immutable_image "${image}"

if [[ ! -f "${error_hub_database}" ]]; then
  printf 'No database exists yet; no pre-deployment backup is required.\n'
  exit 0
fi
if [[ -L "${error_hub_database}" ]]; then
  printf 'Refusing to back up a symbolic-link database.\n' >&2
  exit 1
fi

runtime_uid="${ERROR_HUB_RUNTIME_UID:-1000}"
runtime_gid="${ERROR_HUB_RUNTIME_GID:-1000}"
readonly runtime_uid runtime_gid
if [[ ! "${runtime_uid}" =~ ^[1-9][0-9]*$ \
  || ! "${runtime_gid}" =~ ^[1-9][0-9]*$ ]]; then
  printf 'Online backup requires a numeric non-root runtime UID and GID.\n' >&2
  exit 1
fi

mkdir -p "${error_hub_backup_directory}"
chmod 0700 "${error_hub_backup_directory}"
readonly temporary_backup="${error_hub_backup_directory}/.predeploy.sqlite.tmp"
rm -f "${temporary_backup}"
trap 'rm -f "${temporary_backup}"' EXIT

docker run --rm --interactive \
  --user "${runtime_uid}:${runtime_gid}" \
  --network none \
  --read-only \
  --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --tmpfs /tmp:size=32m,mode=1777 \
  --label sentrybox-check=online-backup \
  --mount "type=bind,src=${error_hub_data_directory},dst=/data" \
  --mount "type=bind,src=${error_hub_backup_directory},dst=/backup" \
  --entrypoint node \
  "${image}" \
  --input-type=module - online-backup \
  <"${database_operations}"

require_safe_snapshot "${temporary_backup}" "SQLite online backup"
chmod 0600 "${temporary_backup}"
mv -f "${temporary_backup}" "${final_backup}"
find "${error_hub_backup_directory}" -maxdepth 1 -type f \
  -name '*.sqlite' ! -name 'predeploy.sqlite' -delete

printf '%s\n' "${final_backup}"

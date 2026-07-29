#!/usr/bin/env bash
set -euo pipefail

script_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly script_directory
# shellcheck source=deploy/home-dev/common.sh
source "${script_directory}/common.sh"
readonly database_operations="${script_directory}/database-operations.mjs"

readonly mode="${1:-}"

if [[ "${mode}" == "scheduled" ]]; then
  printf 'Scheduled external backup is disabled until its destination is configured.\n'
  exit 0
fi
if [[ "${mode}" != "predeploy" ]]; then
  printf 'Usage: backup.sh predeploy IMMUTABLE_IMAGE_DIGEST\n' >&2
  exit 2
fi

readonly image="${2:-}"
error_hub_require_immutable_image "${image}"
error_hub_require_command docker

if [[ ! -f "${error_hub_database}" ]]; then
  printf 'No database exists yet; no pre-deployment backup is required.\n'
  exit 0
fi
if [[ -L "${error_hub_database}" ]]; then
  printf 'Refusing to back up a symbolic-link database.\n' >&2
  exit 1
fi

mkdir -p "${error_hub_backup_directory}"
chmod 0700 "${error_hub_backup_directory}"
readonly temporary_backup="${error_hub_backup_directory}/.predeploy.sqlite.tmp"
readonly final_backup="${error_hub_backup_directory}/predeploy.sqlite"
rm -f "${temporary_backup}"
trap 'rm -f "${temporary_backup}"' EXIT

docker run --rm --interactive \
  --read-only \
  --tmpfs /tmp:size=32m,mode=1777 \
  --label sentrybox-check=online-backup \
  --mount "type=bind,src=${error_hub_data_directory},dst=/data,readonly" \
  --mount "type=bind,src=${error_hub_backup_directory},dst=/backup" \
  --entrypoint node \
  "${image}" \
  --input-type=module - online-backup \
  <"${database_operations}"

if [[ ! -s "${temporary_backup}" ]]; then
  printf 'SQLite online backup did not produce a non-empty snapshot.\n' >&2
  exit 1
fi
backup_bytes="$(stat -c '%s' "${temporary_backup}")"
readonly backup_bytes
if [[ ! "${backup_bytes}" =~ ^[0-9]+$ ]] || (( backup_bytes > 5 * 1024 * 1024 * 1024 )); then
  printf 'SQLite backup exceeds the 5 GiB staging limit.\n' >&2
  exit 1
fi
chmod 0600 "${temporary_backup}"
mv -f "${temporary_backup}" "${final_backup}"
find "${error_hub_backup_directory}" -maxdepth 1 -type f \
  -name '*.sqlite' ! -name 'predeploy.sqlite' -delete

printf '%s\n' "${final_backup}"

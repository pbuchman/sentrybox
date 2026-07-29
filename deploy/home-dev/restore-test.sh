#!/usr/bin/env bash
set -euo pipefail

script_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly script_directory
# shellcheck source=deploy/home-dev/common.sh
source "${script_directory}/common.sh"
readonly database_operations="${script_directory}/database-operations.mjs"
readonly backup_file="${error_hub_backup_directory}/predeploy.sqlite"

for executable in chown df docker flock install mktemp stat; do
  error_hub_require_command "${executable}"
done

mkdir -p "$(dirname "${error_hub_lock_file}")"
exec 9>"${error_hub_lock_file}"
if ! flock -n 9; then
  printf 'Restore validation cannot capture a snapshot while deployment or backup is active.\n' >&2
  exit 1
fi

error_hub_read_state "${error_hub_current_state}"
readonly image="${ERROR_HUB_STATE_IMAGE}"

if [[ ! -f "${backup_file}" || -L "${backup_file}" \
  || ! -s "${backup_file}" ]]; then
  printf 'A non-empty regular pre-deployment backup is required for restore validation.\n' >&2
  exit 1
fi
backup_bytes="$(stat -c '%s' "${backup_file}")"
backup_links="$(stat -c '%h' "${backup_file}")"
readonly backup_bytes backup_links
if [[ "${backup_links}" != "1" ]]; then
  printf 'Pre-deployment backup must be singly linked.\n' >&2
  exit 1
fi
if [[ ! "${backup_bytes}" =~ ^[0-9]+$ ]] \
  || (( backup_bytes > 5 * 1024 * 1024 * 1024 )); then
  printf 'Pre-deployment backup exceeds the 5 GiB restore-test limit.\n' >&2
  exit 1
fi
available_kib="$(df -Pk "${error_hub_state_directory}" | awk 'NR == 2 { print $4 }')"
required_kib=$((15 * 1024 * 1024 + (backup_bytes + 1023) / 1024))
readonly available_kib required_kib
if [[ ! "${available_kib}" =~ ^[0-9]+$ ]] \
  || (( available_kib < required_kib )); then
  printf 'Restore validation requires backup staging space plus a 15 GiB host reserve.\n' >&2
  exit 1
fi

runtime_uid="${ERROR_HUB_RUNTIME_UID:-1000}"
runtime_gid="${ERROR_HUB_RUNTIME_GID:-1000}"
readonly runtime_uid runtime_gid
if [[ ! "${runtime_uid}" =~ ^[1-9][0-9]*$ \
  || ! "${runtime_gid}" =~ ^[1-9][0-9]*$ ]]; then
  printf 'Restore validation requires a numeric non-root runtime UID and GID.\n' >&2
  exit 1
fi

temporary_directory="$(
  mktemp -d "${error_hub_state_directory}/restore-test.XXXXXX"
)"
readonly temporary_directory
case "${temporary_directory}" in
  "${error_hub_state_directory}/restore-test."*) ;;
  *)
    printf 'Restore-test temporary directory is outside deployment state.\n' >&2
    exit 1
    ;;
esac
readonly restore_copy="${temporary_directory}/restore.sqlite"
readonly restore_container="sentrybox-restore-test-$$"
container_attempted=0
restore_success_temporary=""

cleanup() {
  local exit_status=$?
  local cleanup_status=0
  trap - EXIT INT TERM
  if (( container_attempted == 1 )) \
    && ! docker rm --force "${restore_container}" >/dev/null 2>&1; then
    printf 'Restore-test container cleanup failed: %s\n' \
      "${restore_container}" >&2
    cleanup_status=1
  fi
  if [[ -n "${restore_success_temporary}" ]] \
    && ! rm -f -- "${restore_success_temporary}"; then
    printf 'Restore-test success-record cleanup failed.\n' >&2
    cleanup_status=1
  fi
  if ! rm -rf -- "${temporary_directory}" \
    || [[ -e "${temporary_directory}" || -L "${temporary_directory}" ]]; then
    printf 'Restore-test temporary-tree cleanup failed: %s\n' \
      "${temporary_directory}" >&2
    cleanup_status=1
  fi
  if (( cleanup_status != 0 && exit_status == 0 )); then
    exit_status="${cleanup_status}"
  fi
  exit "${exit_status}"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

chmod 0700 "${temporary_directory}"
install -m 0600 "${backup_file}" "${restore_copy}"
chown "${runtime_uid}:${runtime_gid}" \
  "${temporary_directory}" "${restore_copy}"
exec 7<"${database_operations}"
flock -u 9
exec 9>&-

container_attempted=1
docker run --name "${restore_container}" --interactive \
  --user "${runtime_uid}:${runtime_gid}" \
  --network none \
  --read-only \
  --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --tmpfs /tmp:size=32m,mode=1777 \
  --label sentrybox-check=restore-test \
  --mount "type=bind,src=${temporary_directory},dst=/restore" \
  --entrypoint node \
  "${image}" \
  --input-type=module - restore-test \
  <&7
exec 7<&-

restore_success_temporary="$(
  mktemp "${error_hub_state_directory}/.restore-test-success.XXXXXX"
)"
chmod 0600 "${restore_success_temporary}"
mv -f "${restore_success_temporary}" "${error_hub_state_directory}/restore-test.success"
restore_success_temporary=""

printf 'Pre-deployment SentryBox backup passed restore validation.\n'

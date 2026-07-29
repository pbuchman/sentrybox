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

record_backup_state() {
  local local_status="$1"
  local local_reason="$2"
  local state_temporary
  case "${local_status}:${local_reason}" in
    success:none | \
      failure:lock_unavailable | \
      failure:deployment_state_invalid | \
      failure:retained_snapshot_invalid | \
      failure:retained_scrub_failed | \
      failure:scrub_incomplete) ;;
    *)
      printf 'Refusing to publish an invalid local backup scrub state.\n' >&2
      return 1
      ;;
  esac
  error_hub_require_root_private_directory \
    "${error_hub_state_directory}" "SentryBox deployment state directory"
  umask 077
  state_temporary="$(mktemp "${error_hub_backup_state_file}.tmp.XXXXXX")"
  if ! printf '%s\n' \
    'VERSION=1' \
    "CHECKED_AT_EPOCH=$(date +%s)" \
    'EXTERNAL_STATUS=disabled_degraded' \
    'EXTERNAL_REASON=no_external_target' \
    "LOCAL_SCRUB_STATUS=${local_status}" \
    "LOCAL_SCRUB_REASON=${local_reason}" >"${state_temporary}"; then
    rm -f -- "${state_temporary}"
    return 1
  fi
  error_hub_publish_root_private_file \
    "${state_temporary}" "${error_hub_backup_state_file}" \
    "SentryBox backup state"
}

record_scheduled_failure() {
  local reason="$1"
  local message="$2"
  if ! record_backup_state failure "${reason}"; then
    printf 'Scheduled backup failure state could not be published.\n' >&2
  fi
  printf '%s\n' "${message}" >&2
  exit 1
}

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
  local temporary_directory temporary_retained runtime_uid runtime_gid
  local staging_created=0
  error_hub_require_immutable_image "${image}"
  runtime_uid="${ERROR_HUB_RUNTIME_UID:-1000}"
  runtime_gid="${ERROR_HUB_RUNTIME_GID:-1000}"
  if [[ ! "${runtime_uid}" =~ ^[1-9][0-9]*$ \
    || ! "${runtime_gid}" =~ ^[1-9][0-9]*$ ]]; then
    printf 'Retained backup requires a numeric non-root runtime UID and GID.\n' >&2
    return 1
  fi
  require_safe_snapshot "${final_backup}" "Pre-deployment backup"
  temporary_directory="${error_hub_backup_directory}/.retained-finalize"
  temporary_retained="${temporary_directory}/.retained.sqlite.COPY000"

  require_safe_stale_staging() {
    local artifact artifact_name attributes
    if [[ ! -d "${temporary_directory}" || -L "${temporary_directory}" ]]; then
      printf 'Refusing unsafe retained-finalize staging path.\n' >&2
      return 1
    fi
    attributes="$(stat -c '%a:%u:%g' "${temporary_directory}")"
    if [[ "${attributes}" != "700:${runtime_uid}:${runtime_gid}" ]]; then
      printf 'Refusing unsafe retained-finalize staging permissions.\n' >&2
      return 1
    fi
    while IFS= read -r -d '' artifact; do
      artifact_name="${artifact##*/}"
      case "${artifact_name}" in
        .retained.sqlite.COPY000 | \
          .retained.sqlite.COPY000-wal | \
          .retained.sqlite.COPY000-shm) ;;
        *)
          printf 'Refusing unsafe retained-finalize staging artifact: %s\n' \
            "${artifact_name}" >&2
          return 1
          ;;
      esac
      if [[ ! -f "${artifact}" || -L "${artifact}" \
        || "$(stat -c '%a:%u:%g:%h' "${artifact}")" \
          != "600:${runtime_uid}:${runtime_gid}:1" ]]; then
        printf 'Refusing unsafe retained-finalize staging artifact: %s\n' \
          "${artifact_name}" >&2
        return 1
      fi
    done < <(find "${temporary_directory}" -mindepth 1 -maxdepth 1 -print0)
  }

  remove_staging() {
    if ! rm -rf -- "${temporary_directory}" \
      || [[ -e "${temporary_directory}" || -L "${temporary_directory}" ]]; then
      printf 'Retained backup staging cleanup failed: %s\n' \
        "${temporary_directory}" >&2
      return 1
    fi
  }

  # Invoked indirectly by the EXIT trap below.
  # shellcheck disable=SC2329
  cleanup_staging() {
    local exit_status=$?
    trap - EXIT
    if (( staging_created == 1 )) && ! remove_staging; then
      exit_status=1
    fi
    exit "${exit_status}"
  }

  if [[ -e "${temporary_directory}" || -L "${temporary_directory}" ]]; then
    if ! require_safe_stale_staging; then
      return 1
    fi
    if ! remove_staging; then
      return 1
    fi
  fi
  if ! mkdir -m 0700 -- "${temporary_directory}"; then
    printf 'Retained backup staging could not be created safely.\n' >&2
    return 1
  fi
  staging_created=1
  trap cleanup_staging EXIT
  chown "${runtime_uid}:${runtime_gid}" "${temporary_directory}"
  chmod 0700 "${temporary_directory}"
  install -o "${runtime_uid}" -g "${runtime_gid}" -m 0600 \
    "${final_backup}" "${temporary_retained}"
  docker run --rm --interactive \
    --user "${runtime_uid}:${runtime_gid}" \
    --network none \
    --read-only \
    --cap-drop ALL \
    --security-opt no-new-privileges:true \
    --tmpfs /tmp:size=32m,mode=1777 \
    --label sentrybox-check=retained-finalize \
    --mount "type=bind,src=${temporary_directory},dst=/retained" \
    --entrypoint node \
    "${image}" \
    --input-type=module - retained-finalize \
    "/retained/${temporary_retained##*/}" \
    <"${database_operations}"
  require_safe_snapshot "${temporary_retained}" "Retained backup"
  chmod 0600 "${temporary_retained}"
  mv -f "${temporary_retained}" "${final_backup}"
)

if [[ "${mode}" == "scheduled" ]]; then
  for scheduled_command in chown date find flock mkdir rm stat; do
    error_hub_require_command "${scheduled_command}"
  done
  mkdir -p "$(dirname "${error_hub_lock_file}")"
  exec 9>"${error_hub_lock_file}"
  if ! flock -n 9; then
    record_scheduled_failure lock_unavailable \
      'Scheduled external backup is disabled/degraded, and deployment currently owns the backup snapshot.'
  fi
  if ! record_backup_state failure scrub_incomplete; then
    printf 'Scheduled backup cannot publish its local scrub state.\n' >&2
    exit 1
  fi
  if ! error_hub_read_state "${error_hub_current_state}"; then
    record_scheduled_failure deployment_state_invalid \
      'Scheduled external backup is disabled/degraded, and deployment state is invalid.'
  fi
  if ! require_safe_snapshot "${final_backup}" "Retained backup"; then
    record_scheduled_failure retained_snapshot_invalid \
      'Scheduled external backup is disabled/degraded, and no retained snapshot is available.'
  fi
  set +e
  finalize_retained_snapshot "${ERROR_HUB_STATE_IMAGE}"
  finalize_status=$?
  set -e
  if (( finalize_status != 0 )); then
    record_scheduled_failure retained_scrub_failed \
      'Scheduled external backup is disabled/degraded, and the retained snapshot scrub failed.'
  fi
  if ! record_backup_state success none; then
    printf 'Scheduled backup passed its scrub but could not publish the result.\n' >&2
    exit 1
  fi
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

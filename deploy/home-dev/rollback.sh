#!/usr/bin/env bash
set -euo pipefail

script_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly script_directory
# shellcheck source=deploy/home-dev/common.sh
source "${script_directory}/common.sh"
readonly database_operations="${script_directory}/database-operations.mjs"

for executable in chmod curl docker find git jq stat; do
  error_hub_require_command "${executable}"
done

automatic_rollback=0
if (( $# == 1 )) && [[ "$1" == "--automatic" ]]; then
  automatic_rollback=1
elif (( $# != 0 )); then
  printf 'Usage: rollback.sh [--automatic].\n' >&2
  exit 2
fi
readonly automatic_rollback

# Retain the release that was live when this operator rollback began. During an
# automatic deployment rollback deploy.sh first restores current.env, so this
# deliberately identifies the trusted release to recover if the target fails.
error_hub_read_state "${error_hub_current_state}"
readonly current_image="${ERROR_HUB_STATE_IMAGE}"
readonly current_origin="${ERROR_HUB_STATE_PRIVATE_ORIGIN}"
readonly current_sha="${ERROR_HUB_STATE_SHA}"
error_hub_read_state "${error_hub_previous_state}"
readonly previous_image="${ERROR_HUB_STATE_IMAGE}"
readonly previous_origin="${ERROR_HUB_STATE_PRIVATE_ORIGIN}"
readonly previous_sha="${ERROR_HUB_STATE_SHA}"

repository_remote="$(error_hub_git remote get-url origin)"
readonly repository_remote
case "${repository_remote}" in
  https://github.com/pbuchman/sentrybox.git|git@github.com:pbuchman/sentrybox.git) ;;
  *)
    printf 'Canonical SentryBox checkout has an unexpected origin.\n' >&2
    exit 1
    ;;
esac
if [[ -n "$(error_hub_git status --porcelain --untracked-files=normal)" ]]; then
  printf 'Canonical SentryBox deployment checkout must be clean.\n' >&2
  exit 1
fi
original_checkout_sha="$(error_hub_git rev-parse HEAD)"
error_hub_require_sha "${original_checkout_sha}"
readonly original_checkout_sha
if [[ "${current_sha}" != "${original_checkout_sha}" ]] \
  && (( automatic_rollback == 0 )); then
  printf 'Canonical SentryBox checkout does not match deployment state.\n' >&2
  exit 1
fi
if [[ "${current_sha}" != "${original_checkout_sha}" ]] \
  && [[ "${previous_sha}" != "${current_sha}" \
    || "${previous_image}" != "${current_image}" \
    || "${previous_origin}" != "${current_origin}" ]]; then
  printf 'Canonical SentryBox checkout does not match deployment state.\n' >&2
  exit 1
fi
error_hub_fetch_origin_main
error_hub_require_sha "$(error_hub_git rev-parse origin/main)"
error_hub_git cat-file -e "${current_sha}^{commit}"
error_hub_git cat-file -e "${previous_sha}^{commit}"
error_hub_git cat-file -e "${original_checkout_sha}^{commit}"
if ! error_hub_git merge-base --is-ancestor "${previous_sha}" origin/main; then
  printf 'Previous SentryBox release is not reachable from canonical origin/main.\n' >&2
  exit 1
fi
if ! error_hub_git merge-base --is-ancestor "${current_sha}" origin/main; then
  printf 'Current SentryBox release is not reachable from canonical origin/main.\n' >&2
  exit 1
fi
if ! error_hub_git merge-base --is-ancestor \
  "${original_checkout_sha}" origin/main; then
  printf 'Canonical SentryBox checkout is not reachable from origin/main.\n' >&2
  exit 1
fi

checkout_changed=0
runtime_changed=0
rollback_committed=0
restore_temporary=""
state_write_started=0

cleanup() {
  local exit_status=$?
  local checkout_restore_status=0
  local runtime_restore_status=0
  local state_restore_status=0
  trap - EXIT INT TERM
  set +e
  if [[ -n "${restore_temporary}" ]]; then
    rm -f -- "${restore_temporary}" || {
      printf 'Rollback database temporary-file cleanup failed.\n' >&2
      if (( exit_status == 0 )); then
        exit_status=1
      fi
    }
  fi
  if (( checkout_changed == 1 && rollback_committed == 0 )); then
    error_hub_checkout_detached "${current_sha}" \
      || checkout_restore_status=$?
    if (( checkout_restore_status != 0 )); then
      printf 'Rollback checkout restoration failed.\n' >&2
    fi
  fi
  if (( runtime_changed == 1 && rollback_committed == 0 )); then
    if (( checkout_restore_status == 0 )); then
      error_hub_compose_up "${current_image}" "${current_origin}" \
        || runtime_restore_status=$?
      if (( runtime_restore_status == 0 )); then
        error_hub_health_checks "${current_origin}" "${current_image}" \
          || runtime_restore_status=$?
      fi
    else
      runtime_restore_status=1
    fi
    if (( runtime_restore_status != 0 )); then
      printf 'Rollback runtime restoration failed.\n' >&2
    fi
  fi
  if (( state_write_started == 1 && rollback_committed == 0 )); then
    if ! error_hub_read_state "${error_hub_current_state}" \
      || [[ "${ERROR_HUB_STATE_IMAGE:-}" != "${current_image}" \
        || "${ERROR_HUB_STATE_PRIVATE_ORIGIN:-}" != "${current_origin}" \
        || "${ERROR_HUB_STATE_SHA:-}" != "${current_sha}" ]]; then
      error_hub_write_state \
        "${error_hub_current_state}" \
        "${current_image}" \
        "${current_origin}" \
        "${current_sha}" || state_restore_status=$?
    fi
    if (( state_restore_status != 0 )); then
      printf 'Rollback state restoration failed.\n' >&2
    fi
  fi
  if (( exit_status == 0 )); then
    if (( checkout_restore_status != 0 )); then
      exit_status="${checkout_restore_status}"
    elif (( runtime_restore_status != 0 )); then
      exit_status="${runtime_restore_status}"
    elif (( state_restore_status != 0 )); then
      exit_status="${state_restore_status}"
    fi
  fi
  exit "${exit_status}"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Reconcile the checkout before altering runtime or durable state. A checkout
# failure therefore leaves the current runtime/state/HEAD untouched.
error_hub_checkout_detached "${previous_sha}"
checkout_changed=1

runtime_uid="${ERROR_HUB_RUNTIME_UID:-1000}"
runtime_gid="${ERROR_HUB_RUNTIME_GID:-1000}"
readonly runtime_uid runtime_gid
if [[ ! "${runtime_uid}" =~ ^[1-9][0-9]*$ \
  || ! "${runtime_gid}" =~ ^[1-9][0-9]*$ ]]; then
  printf 'Rollback requires a numeric non-root runtime UID and GID.\n' >&2
  exit 1
fi

restart_status=0
runtime_changed=1
error_hub_compose_up "${previous_image}" "${previous_origin}" || restart_status=$?

integrity_status=0
if [[ -f "${error_hub_database}" ]]; then
  docker run --rm --interactive \
    --label sentrybox-check=rollback-integrity \
    --user "${runtime_uid}:${runtime_gid}" \
    --network none \
    --read-only \
    --cap-drop ALL \
    --security-opt no-new-privileges:true \
    --tmpfs /tmp:size=16m,mode=1777 \
    --mount "type=bind,src=${error_hub_data_directory},dst=/data" \
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
  install -m 0600 "${backup_file}" "${restore_temporary}"
  mv -f "${restore_temporary}" "${error_hub_database}"
  restore_temporary=""
  chown "${runtime_uid}:${runtime_gid}" "${error_hub_database}"
  rm -f "${error_hub_database}-wal" "${error_hub_database}-shm"
  error_hub_compose_up "${previous_image}" "${previous_origin}"
  restart_status=0
fi

if (( restart_status != 0 )); then
  printf 'Previous SentryBox image did not restart and the database remains valid; backup was not restored.\n' >&2
  exit "${restart_status}"
fi

error_hub_health_checks "${previous_origin}" "${previous_image}"
if [[ "${previous_image}" != "${current_image}" \
  || "${previous_origin}" != "${current_origin}" \
  || "${previous_sha}" != "${current_sha}" ]]; then
  state_write_started=1
  error_hub_write_state \
    "${error_hub_current_state}" \
    "${previous_image}" \
    "${previous_origin}" \
    "${previous_sha}"
fi
rollback_committed=1

printf 'SentryBox rolled back to %s.\n' "${previous_sha}"

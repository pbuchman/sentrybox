#!/usr/bin/env bash
set -euo pipefail

script_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly script_directory
# shellcheck source=deploy/home-dev/common.sh
source "${script_directory}/common.sh"

for executable in caddy flock install mv setsid sleep systemctl; do
  error_hub_require_command "${executable}"
done

if [[ "${1:-}" == "--" ]]; then
  shift
fi
if (( $# == 0 )); then
  printf 'Usage: maintenance-window.sh -- command [argument ...]\n' >&2
  exit 2
fi

mkdir -p "$(dirname "${error_hub_lock_file}")"
umask 077
exec 9>"${error_hub_lock_file}"
if ! flock -n 9; then
  printf 'A SentryBox deployment or maintenance window is already in progress.\n' >&2
  exit 1
fi

route_changed=0
operator_pid=0
readonly restore_failure_status=70
# A terminated operator may be interrupted during the unit's two-minute stop,
# then run its EXIT recovery through the ten-minute start and readiness checks.
# Preserve that complete bounded recovery before forcing the process group.
readonly operator_stop_timeout_seconds=120
readonly operator_start_timeout_seconds=600
readonly operator_readiness_margin_seconds=30
readonly operator_recovery_grace_seconds=$((
  operator_stop_timeout_seconds + operator_start_timeout_seconds + operator_readiness_margin_seconds
))

# shellcheck disable=SC2329 # Invoked by the EXIT trap.
cleanup() {
  local exit_status=$?
  local restore_status=0
  trap - EXIT
  trap '' HUP INT TERM
  set +e
  if (( route_changed == 1 )); then
    error_hub_apply_caddy_fragment "${error_hub_caddy_normal_source}" \
      || restore_status=$?
    if (( restore_status != 0 )); then
      printf 'Normal Caddy routing could not be restored after the maintenance command.\n' >&2
      exit_status="${restore_failure_status}"
    fi
  fi
  exit "${exit_status}"
}
trap cleanup EXIT

# shellcheck disable=SC2329 # Invoked by the HUP, INT, and TERM traps.
terminate_operator() {
  local requested_signal="$1"
  local requested_status="$2"
  local recovery_deadline=$((SECONDS + operator_recovery_grace_seconds))
  trap '' HUP INT TERM
  set +e
  if (( operator_pid > 0 )); then
    kill -s "${requested_signal}" -- "-${operator_pid}" 2>/dev/null
    while kill -0 -- "-${operator_pid}" 2>/dev/null \
      && (( SECONDS < recovery_deadline )); do
      sleep 0.05
    done
    if kill -0 -- "-${operator_pid}" 2>/dev/null; then
      kill -KILL -- "-${operator_pid}" 2>/dev/null
    fi
    wait "${operator_pid}" 2>/dev/null
    operator_pid=0
  fi
  exit "${requested_status}"
}
trap 'terminate_operator HUP 129' HUP
trap 'terminate_operator INT 130' INT
trap 'terminate_operator TERM 143' TERM

route_changed=1
error_hub_apply_caddy_fragment "${error_hub_caddy_maintenance_source}"

setsid "$@" &
operator_pid=$!
command_status=0
wait "${operator_pid}" || command_status=$?
operator_pid=0
exit "${command_status}"

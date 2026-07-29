#!/usr/bin/env bash
set -euo pipefail

script_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly script_directory
# shellcheck source=deploy/home-dev/common.sh
source "${script_directory}/common.sh"

for executable in awk chown chmod curl date logger mktemp mv rm stat; do
  error_hub_require_command "${executable}"
done

readonly physical_warning_bytes=$((9 * 1024 * 1024 * 1024 / 2))
readonly ingest_disabled_bytes=$((19 * 1024 * 1024 * 1024 / 4))
readonly monitor_max_interval_seconds=$((10 * 60))
readonly restore_test_max_age_seconds=$((35 * 24 * 60 * 60))

emit_monitor_result() {
  local priority="$1"
  local message="$2"
  local alert_list="$3"
  printf '%s\n' \
    "MESSAGE=${message}" \
    "PRIORITY=${priority}" \
    'SENTRYBOX_COMPONENT=operations' \
    'SENTRYBOX_CHECK=home_dev' \
    "SENTRYBOX_ALERTS=${alert_list}" | logger --journald
}

if ! error_hub_require_root_private_directory \
  "${error_hub_state_directory}" "SentryBox deployment state directory"; then
  emit_monitor_result 3 'SentryBox operational alert' 'state_directory_invalid'
  exit 1
fi
if ! error_hub_read_state "${error_hub_current_state}"; then
  emit_monitor_result 3 'SentryBox operational alert' 'deployment_state_invalid'
  exit 1
fi
readonly private_origin="${ERROR_HUB_STATE_PRIVATE_ORIGIN}"

umask 077
metrics_file="$(mktemp "${error_hub_state_directory}/monitor-metrics.XXXXXX")"
readonly metrics_file
trap 'rm -f -- "${metrics_file}"' EXIT

metric_value() {
  local metric_name="$1"
  awk -v metric_name="${metric_name}" '
    $1 == metric_name && $2 ~ /^[0-9]+$/ { print $2; found = 1; exit }
    END { if (!found) exit 1 }
  ' "${metrics_file}"
}

bounded_metric_integer() {
  local value="$1"
  [[ "${value}" =~ ^(0|[1-9][0-9]{0,15})$ ]]
}

file_age_exceeds() {
  local file="$1"
  local limit_seconds="$2"
  local now modified
  now="$(date +%s)"
  modified="$(stat -c '%Y' "${file}")"
  [[ "${now}" =~ ^[0-9]+$ && "${modified}" =~ ^[0-9]+$ ]] || return 0
  (( now - modified > limit_seconds ))
}

read_monitor_baseline() {
  local line key value
  local version="" observed_at="" responses_429="" responses_503=""
  while IFS= read -r line || [[ -n "${line}" ]]; do
    [[ "${line}" == *=* ]] || return 1
    key="${line%%=*}"
    value="${line#*=}"
    case "${key}" in
      VERSION)
        [[ -z "${version}" ]] || return 1
        version="${value}"
        ;;
      OBSERVED_AT_EPOCH)
        [[ -z "${observed_at}" ]] || return 1
        observed_at="${value}"
        ;;
      INGEST_429_TOTAL)
        [[ -z "${responses_429}" ]] || return 1
        responses_429="${value}"
        ;;
      INGEST_503_TOTAL)
        [[ -z "${responses_503}" ]] || return 1
        responses_503="${value}"
        ;;
      *) return 1 ;;
    esac
  done <"${error_hub_monitor_baseline_file}"
  [[ "${version}" == "1" ]] || return 1
  bounded_metric_integer "${observed_at}" || return 1
  bounded_metric_integer "${responses_429}" || return 1
  bounded_metric_integer "${responses_503}" || return 1
  MONITOR_PREVIOUS_OBSERVED_AT="${observed_at}"
  MONITOR_PREVIOUS_429="${responses_429}"
  MONITOR_PREVIOUS_503="${responses_503}"
}

write_monitor_baseline() {
  local observed_at="$1"
  local responses_429="$2"
  local responses_503="$3"
  local baseline_temporary
  baseline_temporary="$(
    mktemp "${error_hub_monitor_baseline_file}.tmp.XXXXXX"
  )"
  if ! printf '%s\n' \
    'VERSION=1' \
    "OBSERVED_AT_EPOCH=${observed_at}" \
    "INGEST_429_TOTAL=${responses_429}" \
    "INGEST_503_TOTAL=${responses_503}" >"${baseline_temporary}"; then
    rm -f -- "${baseline_temporary}"
    return 1
  fi
  error_hub_publish_root_private_file \
    "${baseline_temporary}" "${error_hub_monitor_baseline_file}" \
    "SentryBox monitor baseline"
}

backup_state_is_disabled() {
  local line key value
  local version="" checked_at="" status="" reason=""
  while IFS= read -r line || [[ -n "${line}" ]]; do
    [[ "${line}" == *=* ]] || return 1
    key="${line%%=*}"
    value="${line#*=}"
    case "${key}" in
      VERSION)
        [[ -z "${version}" ]] || return 1
        version="${value}"
        ;;
      CHECKED_AT_EPOCH)
        [[ -z "${checked_at}" ]] || return 1
        checked_at="${value}"
        ;;
      STATUS)
        [[ -z "${status}" ]] || return 1
        status="${value}"
        ;;
      REASON)
        [[ -z "${reason}" ]] || return 1
        reason="${value}"
        ;;
      *) return 1 ;;
    esac
  done <"${error_hub_backup_state_file}"
  [[ "${version}" == "1" \
    && "${status}" == "disabled_degraded" \
    && "${reason}" == "no_external_target" ]] \
    && bounded_metric_integer "${checked_at}"
}

alerts=()
ready_status="000"
if ready_status="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
  --max-time 10 "${private_origin}/health/ready")"; then
  :
fi
if [[ "${ready_status}" != "200" ]]; then
  alerts+=(readiness_failed)
fi

metrics_available=1
if ! curl --silent --show-error --fail --max-time 10 \
  "${private_origin}/metrics" >"${metrics_file}"; then
  metrics_available=0
  alerts+=(metrics_unavailable)
fi

physical_bytes="$(metric_value 'sentrybox_storage_physical_bytes' || true)"
if ! bounded_metric_integer "${physical_bytes}"; then
  alerts+=(physical_usage_unavailable)
elif (( physical_bytes > physical_warning_bytes )); then
  alerts+=(physical_warning)
fi
if bounded_metric_integer "${physical_bytes}" \
  && (( physical_bytes >= ingest_disabled_bytes )); then
  alerts+=(ingest_disabled)
fi

retention_success="$(metric_value 'sentrybox_retention_last_run{outcome="success"}' || true)"
retention_failure="$(metric_value 'sentrybox_retention_last_run{outcome="failure"}' || true)"
if [[ "${retention_success}" == "0" && "${retention_failure}" == "1" ]]; then
  alerts+=(retention_failed)
elif [[ ! "${retention_success}:${retention_failure}" =~ ^(0:0|1:0)$ ]]; then
  alerts+=(retention_status_unavailable)
fi

dead_letters="$(metric_value 'sentrybox_outbox_deliveries{state="dead_letter"}' || true)"
if bounded_metric_integer "${dead_letters}" && (( dead_letters > 0 )); then
  alerts+=(dead_letter_webhook)
fi

# These are application response counters. Reverse-proxy edge responses are not
# represented by the SentryBox process and therefore are outside this check.
responses_429="$(metric_value 'sentrybox_ingest_http_responses_total{status="429"}' || true)"
responses_503="$(metric_value 'sentrybox_ingest_http_responses_total{status="503"}' || true)"
if bounded_metric_integer "${responses_429}" \
  && bounded_metric_integer "${responses_503}"; then
  observed_at="$(date +%s)"
  baseline_valid=0
  monitor_state_alerted=0
  if [[ -e "${error_hub_monitor_baseline_file}" \
    || -L "${error_hub_monitor_baseline_file}" ]]; then
    if error_hub_require_root_private_file \
      "${error_hub_monitor_baseline_file}" "SentryBox monitor baseline" \
      && read_monitor_baseline; then
      baseline_valid=1
    else
      alerts+=(monitor_state_invalid)
      monitor_state_alerted=1
    fi
  fi

  if (( baseline_valid == 1 )); then
    for status in 429 503; do
      if [[ "${status}" == "429" ]]; then
        current="${responses_429}"
        previous="${MONITOR_PREVIOUS_429}"
      else
        current="${responses_503}"
        previous="${MONITOR_PREVIOUS_503}"
      fi
      if (( observed_at < MONITOR_PREVIOUS_OBSERVED_AT \
        || observed_at - MONITOR_PREVIOUS_OBSERVED_AT \
          > monitor_max_interval_seconds )); then
        delta=0
      elif (( current >= previous )); then
        delta=$((current - previous))
      else
        delta="${current}"
      fi
      if (( delta >= 2 )); then
        alerts+=("repeated_${status}")
      fi
    done
  fi
  if ! write_monitor_baseline \
    "${observed_at}" "${responses_429}" "${responses_503}"; then
    if (( monitor_state_alerted == 0 )); then
      alerts+=(monitor_state_invalid)
    fi
  fi
elif (( metrics_available == 1 )); then
  alerts+=(ingest_response_metrics_unavailable)
fi

if [[ -e "${error_hub_backup_state_file}" \
  || -L "${error_hub_backup_state_file}" ]]; then
  if ! error_hub_require_root_private_file \
    "${error_hub_backup_state_file}" "SentryBox backup state" \
    || ! backup_state_is_disabled; then
    alerts+=(backup_state_invalid)
  fi
fi
# Home Dev has no external backup transport. A retained rollback snapshot is
# deliberately never interpreted as a successful off-host backup.
alerts+=(backup_disabled_degraded)

if [[ -e "${error_hub_restore_success_file}" \
  || -L "${error_hub_restore_success_file}" ]]; then
  if ! error_hub_require_root_private_file \
    "${error_hub_restore_success_file}" \
    "SentryBox restore-test success marker"; then
    alerts+=(restore_test_state_invalid)
  elif file_age_exceeds \
    "${error_hub_restore_success_file}" "${restore_test_max_age_seconds}"; then
    alerts+=(restore_test_stale)
  fi
else
  alerts+=(restore_test_stale)
fi

if (( ${#alerts[@]} == 0 )); then
  emit_monitor_result 6 'SentryBox operational check passed' 'none'
  exit 0
fi

IFS=, read -r -d '' alert_list < <(printf '%s,' "${alerts[@]}") || true
alert_list="${alert_list%,}"
emit_monitor_result 3 'SentryBox operational alert' "${alert_list}"
exit 1

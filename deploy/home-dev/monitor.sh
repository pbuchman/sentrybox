#!/usr/bin/env bash
set -euo pipefail

script_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly script_directory
# shellcheck source=deploy/home-dev/common.sh
source "${script_directory}/common.sh"

for executable in curl date logger stat; do
  error_hub_require_command "${executable}"
done

readonly physical_warning_bytes=$((9 * 1024 * 1024 * 1024 / 2))
readonly ingest_disabled_bytes=$((19 * 1024 * 1024 * 1024 / 4))
readonly backup_max_age_seconds=$((26 * 60 * 60))
readonly restore_test_max_age_seconds=$((35 * 24 * 60 * 60))
readonly backup_file="${error_hub_backup_directory}/predeploy.sqlite"
readonly restore_success_file="${error_hub_state_directory}/restore-test.success"
metrics_file="$(mktemp "${error_hub_state_directory}/monitor-metrics.XXXXXX")"
readonly metrics_file
trap 'rm -f -- "${metrics_file}"' EXIT

error_hub_read_state "${error_hub_current_state}"
readonly private_origin="${ERROR_HUB_STATE_PRIVATE_ORIGIN}"

metric_value() {
  local metric_name="$1"
  awk -v metric_name="${metric_name}" '
    $1 == metric_name && $2 ~ /^[0-9]+$/ { print $2; found = 1; exit }
    END { if (!found) exit 1 }
  ' "${metrics_file}"
}

file_age_exceeds() {
  local file="$1"
  local limit_seconds="$2"
  local now modified
  [[ -f "${file}" && ! -L "${file}" ]] || return 0
  now="$(date +%s)"
  modified="$(stat -c '%Y' "${file}")"
  [[ "${now}" =~ ^[0-9]+$ && "${modified}" =~ ^[0-9]+$ ]] || return 0
  (( now - modified > limit_seconds ))
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

if ! curl --silent --show-error --fail --max-time 10 \
  "${private_origin}/metrics" >"${metrics_file}"; then
  alerts+=(metrics_unavailable)
fi

physical_bytes="$(metric_value 'sentrybox_storage_physical_bytes' || true)"
if [[ ! "${physical_bytes}" =~ ^[0-9]+$ ]]; then
  alerts+=(physical_usage_unavailable)
elif (( physical_bytes > physical_warning_bytes )); then
  alerts+=(physical_warning)
fi
if [[ "${physical_bytes}" =~ ^[0-9]+$ ]] \
  && (( physical_bytes >= ingest_disabled_bytes )); then
  alerts+=(ingest_disabled)
fi

retention_failures="$(metric_value 'sentrybox_retention_runs_total{outcome="failure"}' || true)"
if [[ "${retention_failures}" =~ ^[1-9][0-9]*$ ]]; then
  alerts+=(retention_failed)
fi

dead_letters="$(metric_value 'sentrybox_outbox_deliveries{state="dead_letter"}' || true)"
if [[ "${dead_letters}" =~ ^[1-9][0-9]*$ ]]; then
  alerts+=(dead_letter_webhook)
fi

for status in 429 503; do
  failures="$(metric_value "sentrybox_ingest_http_responses_total{status=\"${status}\"}" || true)"
  if [[ "${failures}" =~ ^[0-9]+$ ]] && (( failures >= 2 )); then
    alerts+=("repeated_${status}")
  fi
done

if file_age_exceeds "${backup_file}" "${backup_max_age_seconds}"; then
  alerts+=(backup_stale)
fi
if file_age_exceeds "${restore_success_file}" "${restore_test_max_age_seconds}"; then
  alerts+=(restore_test_stale)
fi

if (( ${#alerts[@]} == 0 )); then
  printf '%s\n' \
    'MESSAGE=SentryBox operational check passed' \
    'PRIORITY=6' \
    'SENTRYBOX_COMPONENT=operations' \
    'SENTRYBOX_CHECK=home_dev' \
    'SENTRYBOX_ALERTS=none' | logger --journald
  exit 0
fi

IFS=, read -r -d '' alert_list < <(printf '%s,' "${alerts[@]}") || true
alert_list="${alert_list%,}"
printf '%s\n' \
  'MESSAGE=SentryBox operational alert' \
  'PRIORITY=3' \
  'SENTRYBOX_COMPONENT=operations' \
  'SENTRYBOX_CHECK=home_dev' \
  "SENTRYBOX_ALERTS=${alert_list}" | logger --journald
exit 1

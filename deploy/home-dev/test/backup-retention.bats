#!/usr/bin/env bats

setup() {
  repository_root="$(cd "${BATS_TEST_DIRNAME}/../../.." && pwd)"
  fixture_root="$(mktemp -d "${BATS_TEST_TMPDIR}/backup-retention.XXXXXX")"
  export ERROR_HUB_TEST_ROOT="${fixture_root}"
  export ERROR_HUB_TEST_MODE=1
  export ERROR_HUB_RUNTIME_UID=1000
  export ERROR_HUB_RUNTIME_GID=1000
  export PATH="${fixture_root}/bin:${PATH}"
  export ERROR_HUB_MONITOR_LOG="${fixture_root}/monitor.log"

  mkdir -p \
    "${fixture_root}/bin" \
    "${fixture_root}/home/pbuchman/services/sentrybox/backups"
  install -d -o 0 -g 0 -m 0700 \
    "${fixture_root}/var/lib/sentrybox-deploy"
  cat >"${fixture_root}/var/lib/sentrybox-deploy/current.env" <<'EOF'
ERROR_HUB_IMAGE=ghcr.io/pbuchman/sentrybox@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
ERROR_HUB_PRIVATE_ORIGIN=https://home-dev.example.ts.net:8443
ERROR_HUB_DEPLOYED_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
EOF
  chown 0:0 "${fixture_root}/var/lib/sentrybox-deploy/current.env"
  chmod 0600 "${fixture_root}/var/lib/sentrybox-deploy/current.env"

  cat >"${fixture_root}/bin/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
case "${*: -1}" in
  */health/ready)
    printf '%s\n' "${ERROR_HUB_FAKE_READY_STATUS:-200}"
    ;;
  */metrics)
    cat "${ERROR_HUB_FAKE_METRICS}"
    ;;
  *)
    exit 64
    ;;
esac
EOF
  cat >"${fixture_root}/bin/logger" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
cat >>"${ERROR_HUB_MONITOR_LOG}"
EOF
  chmod +x "${fixture_root}/bin/curl" "${fixture_root}/bin/logger"
}

teardown() {
  rm -rf "${fixture_root}"
}

write_metrics() {
  local physical_bytes="$1"
  local retention_failures="$2"
  local last_success="$3"
  local last_failure="$4"
  local dead_letters="$5"
  local responses_429="$6"
  local responses_503="$7"
  export ERROR_HUB_FAKE_METRICS="${fixture_root}/metrics"
  printf '%s\n' \
    "sentrybox_storage_physical_bytes ${physical_bytes}" \
    "sentrybox_retention_runs_total{outcome=\"failure\"} ${retention_failures}" \
    "sentrybox_retention_last_run{outcome=\"success\"} ${last_success}" \
    "sentrybox_retention_last_run{outcome=\"failure\"} ${last_failure}" \
    "sentrybox_outbox_deliveries{state=\"dead_letter\"} ${dead_letters}" \
    "sentrybox_ingest_http_responses_total{status=\"429\"} ${responses_429}" \
    "sentrybox_ingest_http_responses_total{status=\"503\"} ${responses_503}" \
    >"${ERROR_HUB_FAKE_METRICS}"
}

write_restore_success() {
  local marker="${fixture_root}/var/lib/sentrybox-deploy/restore-test.success"
  printf 'validated\n' >"${marker}"
  chown 0:0 "${marker}"
  chmod 0600 "${marker}"
}

write_backup_degraded_state() {
  local state="${fixture_root}/var/lib/sentrybox-deploy/backup.state"
  printf '%s\n' \
    'VERSION=1' \
    "CHECKED_AT_EPOCH=$(date +%s)" \
    'STATUS=disabled_degraded' \
    'REASON=no_external_target' >"${state}"
  chown 0:0 "${state}"
  chmod 0600 "${state}"
}

write_monitor_baseline() {
  local responses_429="$1"
  local responses_503="$2"
  local observed_at="${3:-$(date +%s)}"
  local baseline="${fixture_root}/var/lib/sentrybox-deploy/monitor-baseline"
  printf '%s\n' \
    'VERSION=1' \
    "OBSERVED_AT_EPOCH=${observed_at}" \
    "INGEST_429_TOTAL=${responses_429}" \
    "INGEST_503_TOTAL=${responses_503}" >"${baseline}"
  chown 0:0 "${baseline}"
  chmod 0600 "${baseline}"
}

@test "monitor emits only structured private metadata for simultaneous operational failures" {
  write_metrics 5100273664 7 0 1 1 2 2
  write_backup_degraded_state
  write_monitor_baseline 0 0
  write_restore_success
  export ERROR_HUB_FAKE_READY_STATUS=503
  touch -t 202401010000 \
    "${fixture_root}/var/lib/sentrybox-deploy/restore-test.success"

  run "${repository_root}/deploy/home-dev/monitor.sh"

  [ "${status}" -ne 0 ]
  grep -Fx 'MESSAGE=SentryBox operational alert' "${ERROR_HUB_MONITOR_LOG}"
  grep -Fx 'PRIORITY=3' "${ERROR_HUB_MONITOR_LOG}"
  grep -Fx 'SENTRYBOX_ALERTS=readiness_failed,physical_warning,ingest_disabled,retention_failed,dead_letter_webhook,repeated_429,repeated_503,backup_disabled_degraded,restore_test_stale' "${ERROR_HUB_MONITOR_LOG}"
  ! grep -Eiq '(dsn|hmac|token|downloaded_export)=' "${ERROR_HUB_MONITOR_LOG}"
}

@test "monitor ignores lifetime retention failures after the latest run succeeds" {
  write_metrics 4831838208 41 1 0 0 100 200
  write_backup_degraded_state
  write_restore_success

  run "${repository_root}/deploy/home-dev/monitor.sh"

  [ "${status}" -ne 0 ]
  grep -Fx 'SENTRYBOX_ALERTS=backup_disabled_degraded' "${ERROR_HUB_MONITOR_LOG}"
  ! grep -Fq 'retention_failed' "${ERROR_HUB_MONITOR_LOG}"
  ! grep -Fq 'repeated_429' "${ERROR_HUB_MONITOR_LOG}"
  ! grep -Fq 'repeated_503' "${ERROR_HUB_MONITOR_LOG}"
  baseline="${fixture_root}/var/lib/sentrybox-deploy/monitor-baseline"
  [ "$(stat -c '%a:%u:%g:%h' "${baseline}")" = '600:0:0:1' ]
  grep -Fx 'INGEST_429_TOTAL=100' "${baseline}"
  grep -Fx 'INGEST_503_TOTAL=200' "${baseline}"
}

@test "monitor alerts on bounded 429 and 503 deltas rather than lifetime totals" {
  write_metrics 4831838208 0 1 0 0 100 200
  write_backup_degraded_state
  write_restore_success

  run "${repository_root}/deploy/home-dev/monitor.sh"

  [ "${status}" -ne 0 ]
  ! grep -Fq 'repeated_429' "${ERROR_HUB_MONITOR_LOG}"
  ! grep -Fq 'repeated_503' "${ERROR_HUB_MONITOR_LOG}"

  : >"${ERROR_HUB_MONITOR_LOG}"
  write_metrics 4831838208 0 1 0 0 102 202
  run "${repository_root}/deploy/home-dev/monitor.sh"

  [ "${status}" -ne 0 ]
  grep -Fx 'SENTRYBOX_ALERTS=repeated_429,repeated_503,backup_disabled_degraded' \
    "${ERROR_HUB_MONITOR_LOG}"
}

@test "monitor treats counter resets as a new bounded observation window" {
  write_monitor_baseline 500 500
  write_backup_degraded_state
  write_restore_success
  write_metrics 4831838208 0 1 0 0 1 1

  run "${repository_root}/deploy/home-dev/monitor.sh"

  [ "${status}" -ne 0 ]
  ! grep -Fq 'repeated_429' "${ERROR_HUB_MONITOR_LOG}"
  ! grep -Fq 'repeated_503' "${ERROR_HUB_MONITOR_LOG}"

  : >"${ERROR_HUB_MONITOR_LOG}"
  write_metrics 4831838208 0 1 0 0 3 3
  run "${repository_root}/deploy/home-dev/monitor.sh"

  [ "${status}" -ne 0 ]
  grep -Fx 'SENTRYBOX_ALERTS=repeated_429,repeated_503,backup_disabled_degraded' \
    "${ERROR_HUB_MONITOR_LOG}"
}

@test "monitor re-establishes its baseline after an unbounded observation gap" {
  write_monitor_baseline 0 0 1
  write_backup_degraded_state
  write_restore_success
  write_metrics 4831838208 0 1 0 0 100 100

  run "${repository_root}/deploy/home-dev/monitor.sh"

  [ "${status}" -ne 0 ]
  grep -Fx 'SENTRYBOX_ALERTS=backup_disabled_degraded' \
    "${ERROR_HUB_MONITOR_LOG}"
  ! grep -Fq 'repeated_429' "${ERROR_HUB_MONITOR_LOG}"
  ! grep -Fq 'repeated_503' "${ERROR_HUB_MONITOR_LOG}"
}

@test "monitor never treats a fresh rollback snapshot as external backup success" {
  write_metrics 4831838208 0 1 0 0 0 0
  write_restore_success
  printf 'fresh rollback snapshot\n' \
    >"${fixture_root}/home/pbuchman/services/sentrybox/backups/predeploy.sqlite"

  run "${repository_root}/deploy/home-dev/monitor.sh"

  [ "${status}" -ne 0 ]
  grep -Fx 'SENTRYBOX_ALERTS=backup_disabled_degraded' "${ERROR_HUB_MONITOR_LOG}"
  [ ! -e "${fixture_root}/var/lib/sentrybox-deploy/backup.success" ]
}

@test "monitor rejects hard-linked counter and restore state" {
  write_metrics 4831838208 0 1 0 0 900 900
  write_backup_degraded_state
  printf 'unsafe\n' >"${fixture_root}/unsafe-state"
  chmod 0600 "${fixture_root}/unsafe-state"
  ln "${fixture_root}/unsafe-state" \
    "${fixture_root}/var/lib/sentrybox-deploy/monitor-baseline"
  ln "${fixture_root}/unsafe-state" \
    "${fixture_root}/var/lib/sentrybox-deploy/restore-test.success"

  run "${repository_root}/deploy/home-dev/monitor.sh"

  [ "${status}" -ne 0 ]
  grep -Fx 'SENTRYBOX_ALERTS=monitor_state_invalid,backup_disabled_degraded,restore_test_state_invalid' \
    "${ERROR_HUB_MONITOR_LOG}"
  ! grep -Fq 'repeated_429' "${ERROR_HUB_MONITOR_LOG}"
  ! grep -Fq 'repeated_503' "${ERROR_HUB_MONITOR_LOG}"
}

@test "monitor rejects non-canonical trusted counter state before arithmetic" {
  write_metrics 4831838208 0 1 0 0 900 900
  write_backup_degraded_state
  write_restore_success
  baseline="${fixture_root}/var/lib/sentrybox-deploy/monitor-baseline"
  printf '%s\n' \
    'VERSION=1' \
    'OBSERVED_AT_EPOCH=08' \
    'INGEST_429_TOTAL=0' \
    'INGEST_503_TOTAL=0' >"${baseline}"
  chmod 0600 "${baseline}"

  run "${repository_root}/deploy/home-dev/monitor.sh"

  [ "${status}" -ne 0 ]
  grep -Fx 'SENTRYBOX_ALERTS=monitor_state_invalid,backup_disabled_degraded' \
    "${ERROR_HUB_MONITOR_LOG}"
}

@test "monitor rejects unsafe backup state without treating it as success" {
  write_metrics 4831838208 0 1 0 0 0 0
  write_restore_success
  printf '%s\n' \
    'VERSION=1' \
    "CHECKED_AT_EPOCH=$(date +%s)" \
    'STATUS=disabled_degraded' \
    'REASON=no_external_target' >"${fixture_root}/unsafe-backup-state"
  chmod 0600 "${fixture_root}/unsafe-backup-state"
  ln "${fixture_root}/unsafe-backup-state" \
    "${fixture_root}/var/lib/sentrybox-deploy/backup.state"

  run "${repository_root}/deploy/home-dev/monitor.sh"

  [ "${status}" -ne 0 ]
  grep -Fx 'SENTRYBOX_ALERTS=backup_state_invalid,backup_disabled_degraded' \
    "${ERROR_HUB_MONITOR_LOG}"
  [ ! -e "${fixture_root}/var/lib/sentrybox-deploy/backup.success" ]
}

@test "monitor rejects a deployment state directory outside the root-private boundary" {
  write_metrics 4831838208 0 1 0 0 0 0
  chmod 0755 "${fixture_root}/var/lib/sentrybox-deploy"

  run "${repository_root}/deploy/home-dev/monitor.sh"

  [ "${status}" -ne 0 ]
  grep -Fx 'SENTRYBOX_ALERTS=state_directory_invalid' \
    "${ERROR_HUB_MONITOR_LOG}"
  [ ! -e "${fixture_root}/var/lib/sentrybox-deploy/monitor-baseline" ]
}

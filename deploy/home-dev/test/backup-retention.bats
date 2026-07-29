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
    "${fixture_root}/home/pbuchman/services/sentrybox/backups" \
    "${fixture_root}/var/lib/sentrybox-deploy"
  cat >"${fixture_root}/var/lib/sentrybox-deploy/current.env" <<'EOF'
ERROR_HUB_IMAGE=ghcr.io/pbuchman/sentrybox@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
ERROR_HUB_PRIVATE_ORIGIN=https://home-dev.example.ts.net:8443
ERROR_HUB_DEPLOYED_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
EOF

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

write_healthy_metrics() {
  export ERROR_HUB_FAKE_METRICS="${fixture_root}/metrics"
  cat >"${ERROR_HUB_FAKE_METRICS}" <<'EOF'
sentrybox_storage_physical_bytes 4831838208
sentrybox_retention_runs_total{outcome="failure"} 0
sentrybox_outbox_deliveries{state="dead_letter"} 0
sentrybox_ingest_http_responses_total{status="429"} 0
sentrybox_ingest_http_responses_total{status="503"} 0
EOF
}

@test "monitor emits only structured private metadata for simultaneous operational failures" {
  write_healthy_metrics
  export ERROR_HUB_FAKE_READY_STATUS=503
  cat >"${ERROR_HUB_FAKE_METRICS}" <<'EOF'
sentrybox_storage_physical_bytes 5100273664
sentrybox_retention_runs_total{outcome="failure"} 1
sentrybox_outbox_deliveries{state="dead_letter"} 1
sentrybox_ingest_http_responses_total{status="429"} 2
sentrybox_ingest_http_responses_total{status="503"} 2
EOF
  printf 'snapshot\n' >"${fixture_root}/home/pbuchman/services/sentrybox/backups/predeploy.sqlite"
  printf 'restore\n' >"${fixture_root}/var/lib/sentrybox-deploy/restore-test.success"
  touch -t 202401010000 "${fixture_root}/home/pbuchman/services/sentrybox/backups/predeploy.sqlite"
  touch -t 202401010000 "${fixture_root}/var/lib/sentrybox-deploy/restore-test.success"

  run "${repository_root}/deploy/home-dev/monitor.sh"

  [ "${status}" -ne 0 ]
  grep -Fx 'MESSAGE=SentryBox operational alert' "${ERROR_HUB_MONITOR_LOG}"
  grep -Fx 'PRIORITY=3' "${ERROR_HUB_MONITOR_LOG}"
  grep -Fx 'SENTRYBOX_ALERTS=readiness_failed,physical_warning,ingest_disabled,retention_failed,dead_letter_webhook,repeated_429,repeated_503,backup_stale,restore_test_stale' "${ERROR_HUB_MONITOR_LOG}"
  ! grep -Eiq '(dsn|hmac|token|downloaded_export)=' "${ERROR_HUB_MONITOR_LOG}"
}

@test "monitor reports a healthy bounded state without alert metadata" {
  write_healthy_metrics
  printf 'snapshot\n' >"${fixture_root}/home/pbuchman/services/sentrybox/backups/predeploy.sqlite"
  printf 'restore\n' >"${fixture_root}/var/lib/sentrybox-deploy/restore-test.success"

  run "${repository_root}/deploy/home-dev/monitor.sh"

  [ "${status}" -eq 0 ]
  grep -Fx 'MESSAGE=SentryBox operational check passed' "${ERROR_HUB_MONITOR_LOG}"
  grep -Fx 'PRIORITY=6' "${ERROR_HUB_MONITOR_LOG}"
  grep -Fx 'SENTRYBOX_ALERTS=none' "${ERROR_HUB_MONITOR_LOG}"
}

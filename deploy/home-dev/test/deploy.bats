#!/usr/bin/env bats

setup() {
  repository_root="$(cd "${BATS_TEST_DIRNAME}/../../.." && pwd)"
  fixture_root="$(mktemp -d)"
  export ERROR_HUB_TEST_ROOT="${fixture_root}"
  export ERROR_HUB_TEST_MODE=1
  export ERROR_HUB_COMMAND_LOG="${fixture_root}/commands.log"
  export ERROR_HUB_FAKE_STATE="${fixture_root}/fake-state"
  export ERROR_HUB_EXPECTED_SHA="0123456789abcdef0123456789abcdef01234567"
  export ERROR_HUB_FAKE_HEAD_SHA="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  export ERROR_HUB_PRIVATE_ORIGIN="https://home-dev.example.ts.net:8443"
  export ERROR_HUB_RUNTIME_UID=1000
  export ERROR_HUB_RUNTIME_GID=1000
  export PATH="${fixture_root}/fake-bin:${PATH}"

  mkdir -p \
    "${fixture_root}/fake-bin" \
    "${fixture_root}/fake-state" \
    "${fixture_root}/etc/caddy/Caddyfile.d" \
    "${fixture_root}/etc/systemd/system" \
    "${fixture_root}/home/pbuchman/deploy/intexura-error-hub/deploy/home-dev" \
    "${fixture_root}/home/pbuchman/services/intexura-error-hub/data" \
    "${fixture_root}/home/pbuchman/services/intexura-error-hub-backups" \
    "${fixture_root}/run/lock" \
    "${fixture_root}/var/lib/intexura-error-hub-deploy"
  : >"${ERROR_HUB_COMMAND_LOG}"

  cp "${repository_root}/deploy/home-dev/compose.yaml" \
    "${fixture_root}/home/pbuchman/deploy/intexura-error-hub/deploy/home-dev/compose.yaml"
  cp "${repository_root}/deploy/home-dev/config.example.json" \
    "${fixture_root}/home/pbuchman/deploy/intexura-error-hub/deploy/home-dev/config.example.json"
  cp "${repository_root}/deploy/home-dev/caddy-error-hub.caddy" \
    "${fixture_root}/home/pbuchman/deploy/intexura-error-hub/deploy/home-dev/caddy-error-hub.caddy"
  cp "${repository_root}/deploy/home-dev/caddy-error-hub.caddy" \
    "${fixture_root}/etc/caddy/Caddyfile.d/intexura-error-hub.caddy"
  printf '{ import Caddyfile.d/*.caddy }\n' >"${fixture_root}/etc/caddy/Caddyfile"
  printf 'LEGACY_SENTRY_DSN_BACKEND_DEV=redacted\n' \
    >"${fixture_root}/home/pbuchman/services/intexura-error-hub/env"
  chmod 0600 "${fixture_root}/home/pbuchman/services/intexura-error-hub/env"
  printf '%s\n' "${ERROR_HUB_PRIVATE_ORIGIN}" \
    >"${fixture_root}/var/lib/intexura-error-hub-deploy/private-origin"
  chmod 0600 "${fixture_root}/var/lib/intexura-error-hub-deploy/private-origin"

  install_fake_commands
  write_valid_request
}

teardown() {
  rm -rf "${fixture_root}"
}

write_valid_request() {
  printf '%s\n' \
    "{\"version\":1,\"repository\":\"pbuchman/intexura-error-hub\",\"workflow\":\"Release Error Hub Image\",\"headSha\":\"${ERROR_HUB_EXPECTED_SHA}\"}" \
    >"${fixture_root}/var/lib/intexura-error-hub-deploy/deploy-request.json"
  chmod 0600 "${fixture_root}/var/lib/intexura-error-hub-deploy/deploy-request.json"
}

write_runtime_state() {
  image="${1:-ghcr.io/pbuchman/intexura-error-hub@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa}"
  sha="${2:-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa}"
  cat >"${fixture_root}/var/lib/intexura-error-hub-deploy/current.env" <<EOF
ERROR_HUB_IMAGE=${image}
ERROR_HUB_PRIVATE_ORIGIN=${ERROR_HUB_PRIVATE_ORIGIN}
ERROR_HUB_DEPLOYED_SHA=${sha}
EOF
  chmod 0600 "${fixture_root}/var/lib/intexura-error-hub-deploy/current.env"
}

install_fake_commands() {
  cat >"${fixture_root}/fake-bin/df" <<'EOF'
#!/bin/sh
available="${ERROR_HUB_FAKE_AVAILABLE_KIB:-40000000}"
printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\n'
printf '/dev/fake 50000000 10000000 %s 20%% /\n' "${available}"
EOF

  cat >"${fixture_root}/fake-bin/ss" <<'EOF'
#!/bin/sh
if [ "${ERROR_HUB_FAKE_PORTS_BUSY:-0}" = 1 ]; then
  printf 'LISTEN 0 4096 127.0.0.1:8140 0.0.0.0:*\n'
  printf 'LISTEN 0 4096 127.0.0.1:8141 0.0.0.0:*\n'
fi
EOF

  cat >"${fixture_root}/fake-bin/git" <<'EOF'
#!/bin/sh
printf 'git %s\n' "$*" >>"${ERROR_HUB_COMMAND_LOG}"
if [ "${ERROR_HUB_FAKE_BLOCK_FETCH:-0}" = 1 ] && printf '%s' "$*" | grep -q ' fetch '; then
  : >"${ERROR_HUB_FAKE_STATE}/fetch-blocked"
  sleep 0.4
fi
case "$*" in
  *"remote get-url origin"*) printf '%s\n' 'https://github.com/pbuchman/intexura-error-hub.git' ;;
  *"status --porcelain"*) ;;
  *"rev-parse origin/main"*) printf '%s\n' "${ERROR_HUB_EXPECTED_SHA}" ;;
  *"rev-parse HEAD"*) printf '%s\n' "${ERROR_HUB_FAKE_HEAD_SHA}" ;;
  *) ;;
esac
EOF

  cat >"${fixture_root}/fake-bin/docker" <<'EOF'
#!/bin/sh
printf 'docker ERROR_HUB_IMAGE=%s %s\n' "${ERROR_HUB_IMAGE:-}" "$*" >>"${ERROR_HUB_COMMAND_LOG}"
case "$1 $2 $3" in
  "info  "|"compose version ") exit 0 ;;
esac
if printf ' %s ' "$*" | grep -q ' compose .* ps -q error-hub '; then
  [ "${ERROR_HUB_FAKE_PORTS_BUSY:-0}" = 1 ] && printf 'existing-container\n'
  exit 0
fi
if [ "$1" = inspect ]; then
  printf '%s\n' '{"8080/tcp":[{"HostIp":"127.0.0.1","HostPort":"8140"}],"8081/tcp":[{"HostIp":"127.0.0.1","HostPort":"8141"}]}'
  exit 0
fi
if [ "$1" = pull ]; then
  [ "${ERROR_HUB_FAKE_PULL_FAIL:-0}" = 1 ] && exit 1
  exit 0
fi
if [ "$1" = image ] && [ "$2" = inspect ]; then
  printf '%s\n' 'ghcr.io/pbuchman/intexura-error-hub@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
  exit 0
fi
if [ "$1" = run ]; then
  if [ "${ERROR_HUB_FAKE_BACKUP_FAIL:-0}" = 1 ] && printf '%s' "$*" | grep -q '/backup'; then
    exit 1
  fi
  if printf '%s' "$*" | grep -q '/backup'; then
    backup_root="$(printf '%s\n' "$*" | sed -n 's/.*src=\([^,]*\),dst=\/backup.*/\1/p')"
    printf 'consistent-backup\n' >"${backup_root}/.predeploy.sqlite.tmp"
    if [ "${ERROR_HUB_FAKE_BACKUP_OVERSIZE:-0}" = 1 ]; then
      truncate -s 5368709121 "${backup_root}/.predeploy.sqlite.tmp"
    fi
  fi
  if [ "${ERROR_HUB_FAKE_COMPAT_FAIL:-0}" = 1 ] && printf '%s' "$*" | grep -q 'compatibility-previous'; then
    exit 1
  fi
  if [ "${ERROR_HUB_FAKE_INTEGRITY_FAIL:-0}" = 1 ] && printf '%s' "$*" | grep -q 'rollback-integrity'; then
    exit 1
  fi
  exit 0
fi
if printf ' %s ' "$*" | grep -q ' compose .* up -d --wait --remove-orphans '; then
  count_file="${ERROR_HUB_FAKE_STATE}/compose-up-count"
  count=0
  [ -f "${count_file}" ] && count="$(cat "${count_file}")"
  count=$((count + 1))
  printf '%s\n' "${count}" >"${count_file}"
  [ "${ERROR_HUB_FAKE_UP_FAIL:-0}" = 1 ] && [ "${count}" -eq 1 ] && exit 1
  exit 0
fi
exit 0
EOF

  cat >"${fixture_root}/fake-bin/curl" <<'EOF'
#!/bin/sh
printf 'curl %s\n' "$*" >>"${ERROR_HUB_COMMAND_LOG}"
if [ "${ERROR_HUB_FAKE_READINESS_FAIL:-0}" = 1 ]; then
  count=0
  [ -f "${ERROR_HUB_FAKE_STATE}/compose-up-count" ] && count="$(cat "${ERROR_HUB_FAKE_STATE}/compose-up-count")"
  [ "${count}" -eq 1 ] && exit 22
fi
exit 0
EOF

  cat >"${fixture_root}/fake-bin/caddy" <<'EOF'
#!/bin/sh
printf 'caddy %s\n' "$*" >>"${ERROR_HUB_COMMAND_LOG}"
exit 0
EOF

  cat >"${fixture_root}/fake-bin/systemctl" <<'EOF'
#!/bin/sh
printf 'systemctl %s\n' "$*" >>"${ERROR_HUB_COMMAND_LOG}"
if [ "${ERROR_HUB_FAKE_CADDY_RESTORE_FAIL:-0}" = 1 ] && [ "$*" = 'reload caddy' ]; then
  count_file="${ERROR_HUB_FAKE_STATE}/caddy-reload-count"
  count=0
  [ -f "${count_file}" ] && count="$(cat "${count_file}")"
  count=$((count + 1))
  printf '%s\n' "${count}" >"${count_file}"
  [ "${count}" -ge 2 ] && exit 1
fi
exit 0
EOF

  for command in caddy systemctl; do
    chmod +x "${fixture_root}/fake-bin/${command}"
  done

  chmod +x "${fixture_root}/fake-bin/"*
}

@test "install creates only the canonical Home Dev application paths with restrictive permissions" {
  run "${repository_root}/deploy/home-dev/install.sh" \
    --private-origin "${ERROR_HUB_PRIVATE_ORIGIN}"

  [ "${status}" -eq 0 ]
  [ -d "${fixture_root}/home/pbuchman/deploy/intexura-error-hub" ]
  [ -f "${fixture_root}/home/pbuchman/services/intexura-error-hub/env" ]
  [ -d "${fixture_root}/home/pbuchman/services/intexura-error-hub/data" ]
  [ -d "${fixture_root}/home/pbuchman/services/intexura-error-hub-backups" ]
  [ "$(stat -c '%a' "${fixture_root}/home/pbuchman/services/intexura-error-hub/env")" = 600 ]
  [ "$(stat -c '%a' "${fixture_root}/home/pbuchman/services/intexura-error-hub/data")" = 700 ]
  [ "$(stat -c '%a' "${fixture_root}/home/pbuchman/services/intexura-error-hub-backups")" = 700 ]
  run sh -c "find '${fixture_root}/home/pbuchman/services' -mindepth 1 -maxdepth 1 -print | sed 's#.*/##' | sort"
  [ "${status}" -eq 0 ]
  [ "${output}" = $'intexura-error-hub\nintexura-error-hub-backups' ]
}

@test "preflight refuses less than 15 GiB and immutable image violations" {
  export ERROR_HUB_FAKE_AVAILABLE_KIB=15728639
  run "${repository_root}/deploy/home-dev/preflight.sh" \
    "ghcr.io/pbuchman/intexura-error-hub@sha256:$(printf 'b%.0s' $(seq 1 64))"
  [ "${status}" -ne 0 ]
  [[ "${output}" == *"15 GiB"* ]]

  export ERROR_HUB_FAKE_AVAILABLE_KIB=40000000
  run "${repository_root}/deploy/home-dev/preflight.sh"
  [ "${status}" -ne 0 ]
  [[ "${output}" == *"immutable"* ]]

  run "${repository_root}/deploy/home-dev/preflight.sh" \
    "ghcr.io/pbuchman/intexura-error-hub:latest"
  [ "${status}" -ne 0 ]
  [[ "${output}" == *"immutable"* ]]
}

@test "preflight proves the container runtime UID can write the data mount" {
  run "${repository_root}/deploy/home-dev/preflight.sh" \
    "ghcr.io/pbuchman/intexura-error-hub@sha256:$(printf 'b%.0s' $(seq 1 64))"

  [ "${status}" -eq 0 ]
  run grep -F 'runtime-write' "${ERROR_HUB_COMMAND_LOG}"
  [ "${status}" -eq 0 ]
}

@test "deploy lock rejects contention before consuming the webhook request" {
  lock="${fixture_root}/run/lock/intexura-error-hub-deploy.lock"
  exec 8>"${lock}"
  flock -n 8

  run "${repository_root}/deploy/home-dev/deploy.sh"

  [ "${status}" -ne 0 ]
  [[ "${output}" == *"already in progress"* ]]
  [ -f "${fixture_root}/var/lib/intexura-error-hub-deploy/deploy-request.json" ]
}

@test "deploy rejects wrong webhook identity and removes the claimed request" {
  printf '%s\n' \
    "{\"version\":1,\"repository\":\"attacker/repository\",\"workflow\":\"Release Error Hub Image\",\"headSha\":\"${ERROR_HUB_EXPECTED_SHA}\"}" \
    >"${fixture_root}/var/lib/intexura-error-hub-deploy/deploy-request.json"

  run "${repository_root}/deploy/home-dev/deploy.sh"

  [ "${status}" -ne 0 ]
  [ ! -e "${fixture_root}/var/lib/intexura-error-hub-deploy/deploy-request.json" ]
  run find "${fixture_root}/var/lib/intexura-error-hub-deploy" -name 'deploy-request.processing.*' -print
  [ -z "${output}" ]
  run grep '^docker pull ' "${ERROR_HUB_COMMAND_LOG}"
  [ "${status}" -ne 0 ]
}

@test "deploy checks 15 GiB free space before pulling the release image" {
  export ERROR_HUB_FAKE_AVAILABLE_KIB=15728639

  run "${repository_root}/deploy/home-dev/deploy.sh"

  [ "${status}" -ne 0 ]
  [[ "${output}" == *"15 GiB"* ]]
  run grep '^docker ERROR_HUB_IMAGE= pull ' "${ERROR_HUB_COMMAND_LOG}"
  [ "${status}" -ne 0 ]
  [ ! -e "${fixture_root}/var/lib/intexura-error-hub-deploy/deploy-request.json" ]
}

@test "deploy claims and removes a request with invalid file metadata" {
  chmod 0644 "${fixture_root}/var/lib/intexura-error-hub-deploy/deploy-request.json"

  run "${repository_root}/deploy/home-dev/deploy.sh"

  [ "${status}" -ne 0 ]
  [ ! -e "${fixture_root}/var/lib/intexura-error-hub-deploy/deploy-request.json" ]
  run find "${fixture_root}/var/lib/intexura-error-hub-deploy" -name 'deploy-request.processing.*' -print
  [ -z "${output}" ]
}

@test "terminated deployment removes its claimed request and reports signal failure" {
  export ERROR_HUB_FAKE_BLOCK_FETCH=1
  run timeout -s TERM 0.05 "${repository_root}/deploy/home-dev/deploy.sh"

  [ "${status}" -eq 143 ]
  [ ! -e "${fixture_root}/var/lib/intexura-error-hub-deploy/deploy-request.json" ]
  run find "${fixture_root}/var/lib/intexura-error-hub-deploy" -name 'deploy-request.processing.*' -print
  [ -z "${output}" ]
}

@test "failed readiness automatically restores the previous digest before checking the database" {
  write_runtime_state
  printf 'live-database\n' \
    >"${fixture_root}/home/pbuchman/services/intexura-error-hub/data/error-hub.sqlite"
  export ERROR_HUB_FAKE_READINESS_FAIL=1

  run "${repository_root}/deploy/home-dev/deploy.sh"

  [ "${status}" -ne 0 ]
  [ "$(cat "${fixture_root}/fake-state/compose-up-count")" -eq 2 ]
  first_previous="$(grep -n 'ERROR_HUB_IMAGE=ghcr.io/pbuchman/intexura-error-hub@sha256:aaaaaaaa' "${ERROR_HUB_COMMAND_LOG}" | head -1 | cut -d: -f1)"
  first_integrity="$(grep -n 'rollback-integrity' "${ERROR_HUB_COMMAND_LOG}" | head -1 | cut -d: -f1)"
  [ -n "${first_previous}" ]
  [ -n "${first_integrity}" ]
  [ "${first_previous}" -lt "${first_integrity}" ]
  [ ! -e "${fixture_root}/var/lib/intexura-error-hub-deploy/deploy-request.json" ]
  run grep -F 'respond "temporarily unavailable" 503' \
    "${fixture_root}/etc/caddy/Caddyfile.d/intexura-error-hub.caddy"
  [ "${status}" -ne 0 ]
}

@test "rollback keeps a healthy database and restores a backup only after a failed integrity check" {
  write_runtime_state
  cp "${fixture_root}/var/lib/intexura-error-hub-deploy/current.env" \
    "${fixture_root}/var/lib/intexura-error-hub-deploy/previous.env"
  printf 'live-database\n' \
    >"${fixture_root}/home/pbuchman/services/intexura-error-hub/data/error-hub.sqlite"
  printf 'consistent-backup\n' \
    >"${fixture_root}/home/pbuchman/services/intexura-error-hub-backups/predeploy.sqlite"

  run "${repository_root}/deploy/home-dev/rollback.sh"
  [ "${status}" -eq 0 ]
  [ "$(cat "${fixture_root}/home/pbuchman/services/intexura-error-hub/data/error-hub.sqlite")" = 'live-database' ]

  export ERROR_HUB_FAKE_INTEGRITY_FAIL=1
  run "${repository_root}/deploy/home-dev/rollback.sh"
  [ "${status}" -eq 0 ]
  [ "$(cat "${fixture_root}/home/pbuchman/services/intexura-error-hub/data/error-hub.sqlite")" = 'consistent-backup' ]
  [ "$(stat -c '%u:%g' "${fixture_root}/home/pbuchman/services/intexura-error-hub/data/error-hub.sqlite")" = '1000:1000' ]
}

@test "predeploy backup uses SQLite online backup and retains only one local snapshot" {
  write_runtime_state
  printf 'live-database\n' \
    >"${fixture_root}/home/pbuchman/services/intexura-error-hub/data/error-hub.sqlite"
  printf 'stale\n' \
    >"${fixture_root}/home/pbuchman/services/intexura-error-hub-backups/old.sqlite"

  run "${repository_root}/deploy/home-dev/backup.sh" predeploy \
    "ghcr.io/pbuchman/intexura-error-hub@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

  [ "${status}" -eq 0 ]
  [ -s "${fixture_root}/home/pbuchman/services/intexura-error-hub-backups/predeploy.sqlite" ]
  [ ! -e "${fixture_root}/home/pbuchman/services/intexura-error-hub-backups/old.sqlite" ]
  [ "$(find "${fixture_root}/home/pbuchman/services/intexura-error-hub-backups" -maxdepth 1 -name '*.sqlite' | wc -l | tr -d ' ')" -eq 1 ]
  run grep -F 'online-backup' "${ERROR_HUB_COMMAND_LOG}"
  [ "${status}" -eq 0 ]
  run grep -E '(^| )cp .*/data/error-hub.sqlite' "${ERROR_HUB_COMMAND_LOG}"
  [ "${status}" -ne 0 ]
}

@test "oversized backup is rejected without replacing the last known-good snapshot" {
  printf 'live-database\n' \
    >"${fixture_root}/home/pbuchman/services/intexura-error-hub/data/error-hub.sqlite"
  printf 'last-known-good\n' \
    >"${fixture_root}/home/pbuchman/services/intexura-error-hub-backups/predeploy.sqlite"
  export ERROR_HUB_FAKE_BACKUP_OVERSIZE=1

  run "${repository_root}/deploy/home-dev/backup.sh" predeploy \
    "ghcr.io/pbuchman/intexura-error-hub@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

  [ "${status}" -ne 0 ]
  [[ "${output}" == *"5 GiB"* ]]
  [ "$(cat "${fixture_root}/home/pbuchman/services/intexura-error-hub-backups/predeploy.sqlite")" = 'last-known-good' ]
  [ ! -e "${fixture_root}/home/pbuchman/services/intexura-error-hub-backups/.predeploy.sqlite.tmp" ]
}

@test "backup failure aborts deployment before the new image starts and normal Caddy is restored" {
  write_runtime_state
  printf 'live-database\n' \
    >"${fixture_root}/home/pbuchman/services/intexura-error-hub/data/error-hub.sqlite"
  export ERROR_HUB_FAKE_BACKUP_FAIL=1

  run "${repository_root}/deploy/home-dev/deploy.sh"

  [ "${status}" -ne 0 ]
  [ ! -e "${fixture_root}/fake-state/compose-up-count" ]
  run grep -F 'reverse_proxy 127.0.0.1:8140' \
    "${fixture_root}/etc/caddy/Caddyfile.d/intexura-error-hub.caddy"
  [ "${status}" -eq 0 ]
  run grep -F 'systemctl reload caddy' "${ERROR_HUB_COMMAND_LOG}"
  [ "${status}" -eq 0 ]
  run grep -F "checkout --quiet --detach ${ERROR_HUB_FAKE_HEAD_SHA}" "${ERROR_HUB_COMMAND_LOG}"
  [ "${status}" -eq 0 ]
}

@test "migration probe requires the immediately previous runtime to read the upgraded copy" {
  write_runtime_state
  printf 'live-database\n' \
    >"${fixture_root}/home/pbuchman/services/intexura-error-hub/data/error-hub.sqlite"
  export ERROR_HUB_FAKE_COMPAT_FAIL=1

  run "${repository_root}/deploy/home-dev/deploy.sh"

  [ "${status}" -ne 0 ]
  [ ! -e "${fixture_root}/fake-state/compose-up-count" ]
  run grep -F 'compatibility-new' "${ERROR_HUB_COMMAND_LOG}"
  [ "${status}" -eq 0 ]
  run grep -F 'compatibility-previous' "${ERROR_HUB_COMMAND_LOG}"
  [ "${status}" -eq 0 ]
}

@test "successful deployment consumes one request and records only the immutable resolved digest" {
  run "${repository_root}/deploy/home-dev/deploy.sh"

  [ "${status}" -eq 0 ]
  [ ! -e "${fixture_root}/var/lib/intexura-error-hub-deploy/deploy-request.json" ]
  run grep -F 'ERROR_HUB_IMAGE=ghcr.io/pbuchman/intexura-error-hub@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' \
    "${fixture_root}/var/lib/intexura-error-hub-deploy/current.env"
  [ "${status}" -eq 0 ]
  run grep -F 'compose --file' "${ERROR_HUB_COMMAND_LOG}"
  [ "${status}" -eq 0 ]
  [[ "${output}" == *"up -d --wait --remove-orphans"* ]]
}

@test "failed normal Caddy restore rolls back before committing the new deployment state" {
  write_runtime_state
  export ERROR_HUB_FAKE_CADDY_RESTORE_FAIL=1

  run "${repository_root}/deploy/home-dev/deploy.sh"

  [ "${status}" -ne 0 ]
  [ "$(cat "${fixture_root}/fake-state/compose-up-count")" -eq 2 ]
  run grep -F 'ERROR_HUB_IMAGE=ghcr.io/pbuchman/intexura-error-hub@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' \
    "${fixture_root}/var/lib/intexura-error-hub-deploy/current.env"
  [ "${status}" -eq 0 ]
  [ ! -e "${fixture_root}/var/lib/intexura-error-hub-deploy/deploy-request.json" ]
}

@test "installed systemd units use fixed scripts, state, timers, and no webhook Docker access" {
  run "${repository_root}/deploy/home-dev/install.sh" \
    --private-origin "${ERROR_HUB_PRIVATE_ORIGIN}"
  [ "${status}" -eq 0 ]

  deploy_unit="${fixture_root}/etc/systemd/system/intexura-error-hub-deploy.service"
  runtime_unit="${fixture_root}/etc/systemd/system/intexura-error-hub.service"
  backup_timer="${fixture_root}/etc/systemd/system/intexura-error-hub-backup.timer"
  restore_timer="${fixture_root}/etc/systemd/system/intexura-error-hub-restore-test.timer"
  restore_unit="${fixture_root}/etc/systemd/system/intexura-error-hub-restore-test.service"
  run grep -F 'StateDirectory=intexura-error-hub-deploy' "${deploy_unit}"
  [ "${status}" -eq 0 ]
  run grep -F 'ExecStart=/home/pbuchman/deploy/intexura-error-hub/deploy/home-dev/deploy.sh' "${deploy_unit}"
  [ "${status}" -eq 0 ]
  run grep -F 'ExecStopPost=/usr/bin/install -m 0644 /home/pbuchman/deploy/intexura-error-hub/deploy/home-dev/caddy-error-hub.caddy /etc/caddy/Caddyfile.d/intexura-error-hub.caddy' "${deploy_unit}"
  [ "${status}" -eq 0 ]
  run grep -F 'ExecStopPost=/usr/bin/caddy validate --config /etc/caddy/Caddyfile' "${deploy_unit}"
  [ "${status}" -eq 0 ]
  run grep -F 'ExecStopPost=/usr/bin/systemctl reload caddy' "${deploy_unit}"
  [ "${status}" -eq 0 ]
  run grep -F 'WorkingDirectory=/home/pbuchman/deploy/intexura-error-hub' "${runtime_unit}"
  [ "${status}" -eq 0 ]
  run grep -F 'Persistent=true' "${backup_timer}"
  [ "${status}" -eq 0 ]
  run grep -F 'Persistent=true' "${restore_timer}"
  [ "${status}" -eq 0 ]
  run grep -F 'ConditionFileIsExecutable=/home/pbuchman/deploy/intexura-error-hub/deploy/home-dev/restore-test.sh' "${restore_unit}"
  [ "${status}" -eq 0 ]
  run grep -F 'ConditionPathIsExecutable=' "${restore_unit}"
  [ "${status}" -ne 0 ]
  run grep -R -E 'deploy-request\.json.*(docker\.sock|/data)|intexura-error-hub-deploy-webhook.*docker\.sock' \
    "${fixture_root}/etc/systemd/system"
  [ "${status}" -ne 0 ]
}

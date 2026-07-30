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
    "${fixture_root}/home/pbuchman/deploy/sentrybox/.git/objects" \
    "${fixture_root}/home/pbuchman/deploy/sentrybox/deploy/home-dev" \
    "${fixture_root}/home/pbuchman/services/sentrybox/data" \
    "${fixture_root}/home/pbuchman/services/sentrybox/backups" \
    "${fixture_root}/opt/nodejs/current/bin" \
    "${fixture_root}/run/lock" \
    "${fixture_root}/var/lib/sentrybox-deploy"
  chmod 0700 "${fixture_root}/var/lib/sentrybox-deploy"
  : >"${ERROR_HUB_COMMAND_LOG}"
  printf '%s\n' "${ERROR_HUB_FAKE_HEAD_SHA}" >"${ERROR_HUB_FAKE_STATE}/git-head"

  cp "${repository_root}/deploy/home-dev/compose.yaml" \
    "${fixture_root}/home/pbuchman/deploy/sentrybox/deploy/home-dev/compose.yaml"
  cp "${repository_root}/deploy/home-dev/config.example.json" \
    "${fixture_root}/home/pbuchman/deploy/sentrybox/deploy/home-dev/config.example.json"
  cp "${repository_root}/deploy/home-dev/caddy-sentrybox.caddy" \
    "${fixture_root}/home/pbuchman/deploy/sentrybox/deploy/home-dev/caddy-sentrybox.caddy"
  cp "${repository_root}/deploy/home-dev/caddy-sentrybox-maintenance.caddy" \
    "${fixture_root}/home/pbuchman/deploy/sentrybox/deploy/home-dev/caddy-sentrybox-maintenance.caddy"
  cp "${repository_root}/deploy/home-dev/caddy-sentrybox-deploy.caddy" \
    "${fixture_root}/home/pbuchman/deploy/sentrybox/deploy/home-dev/caddy-sentrybox-deploy.caddy"
  cp "${repository_root}/deploy/home-dev/database-operations.mjs" \
    "${fixture_root}/home/pbuchman/deploy/sentrybox/deploy/home-dev/database-operations.mjs"
  printf '{ import Caddyfile.d/*.caddy }\n' >"${fixture_root}/etc/caddy/Caddyfile"
  printf '%s\n' \
    'CODE_AGENT_HMAC_DEV=redacted' \
    'CODE_AGENT_HMAC_PROD=redacted' \
    >"${fixture_root}/home/pbuchman/services/sentrybox/env"
  chmod 0600 "${fixture_root}/home/pbuchman/services/sentrybox/env"
  printf '%s\n' "${ERROR_HUB_PRIVATE_ORIGIN}" \
    >"${fixture_root}/var/lib/sentrybox-deploy/private-origin"
  chmod 0600 "${fixture_root}/var/lib/sentrybox-deploy/private-origin"
  printf '%s\n' \
    'ERROR_HUB_REQUIRED_SECRET_REFERENCES=CODE_AGENT_HMAC_DEV,CODE_AGENT_HMAC_PROD' \
    >"${fixture_root}/var/lib/sentrybox-deploy/runtime.env"
  chmod 0600 "${fixture_root}/var/lib/sentrybox-deploy/runtime.env"
  cat >"${fixture_root}/opt/nodejs/current/bin/node" <<'EOF'
#!/bin/sh
printf '%s\n' "${ERROR_HUB_FAKE_SYSTEM_NODE_VERSION:-v22.23.2}"
EOF
  chmod 0755 "${fixture_root}/opt/nodejs/current/bin/node"

  install_fake_commands
  write_valid_request
}

teardown() {
  PATH="${PATH#"${fixture_root}/fake-bin:"}"
  export PATH
  /bin/rm -rf "${fixture_root}"
}

write_valid_request() {
  printf '%s\n' \
    "{\"version\":1,\"repository\":\"pbuchman/sentrybox\",\"workflow\":\"Release SentryBox Image\",\"headSha\":\"${ERROR_HUB_EXPECTED_SHA}\"}" \
    >"${fixture_root}/var/lib/sentrybox-deploy/deploy-request.json"
  chmod 0600 "${fixture_root}/var/lib/sentrybox-deploy/deploy-request.json"
}

write_runtime_state() {
  image="${1:-ghcr.io/pbuchman/sentrybox@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa}"
  sha="${2:-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa}"
  cat >"${fixture_root}/var/lib/sentrybox-deploy/current.env" <<EOF
ERROR_HUB_IMAGE=${image}
ERROR_HUB_PRIVATE_ORIGIN=${ERROR_HUB_PRIVATE_ORIGIN}
ERROR_HUB_DEPLOYED_SHA=${sha}
EOF
  chmod 0600 "${fixture_root}/var/lib/sentrybox-deploy/current.env"
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
printf 'git-umask %s %s\n' "$(umask)" "$*" >>"${ERROR_HUB_COMMAND_LOG}"
if [ "${ERROR_HUB_FAKE_BLOCK_FETCH:-0}" = 1 ] && printf '%s' "$*" | grep -q ' fetch '; then
  : >"${ERROR_HUB_FAKE_STATE}/fetch-blocked"
  sleep 0.4
fi
if [ -n "${ERROR_HUB_FAKE_NON_CANONICAL_SHA:-}" ] \
  && printf '%s' "$*" | grep -Fq \
    "merge-base --is-ancestor ${ERROR_HUB_FAKE_NON_CANONICAL_SHA} origin/main"; then
  exit 1
fi
case "$*" in
  *"remote get-url origin"*) printf '%s\n' 'https://github.com/pbuchman/sentrybox.git' ;;
  *"status --porcelain"*) ;;
  *"rev-parse origin/main"*) printf '%s\n' "${ERROR_HUB_EXPECTED_SHA}" ;;
  *"rev-parse HEAD"*) cat "${ERROR_HUB_FAKE_STATE}/git-head" ;;
  *"fetch --quiet origin main"*)
    if [ "${ERROR_HUB_FAKE_FETCH_OBJECT:-0}" = 1 ]; then
      object_directory="${ERROR_HUB_TEST_ROOT}/home/pbuchman/deploy/sentrybox/.git/objects/bb"
      mkdir -p "${object_directory}"
      printf 'fetched-object\n' >"${object_directory}/fetched"
    fi
    ;;
  *"checkout --quiet --detach"*)
    checkout_sha=''
    for git_argument do checkout_sha="${git_argument}"; done
    if [ "${ERROR_HUB_FAKE_CHECKOUT_FAIL_ONCE_SHA:-}" = "${checkout_sha}" ] \
      && [ ! -e "${ERROR_HUB_FAKE_STATE}/checkout-failed-once-${checkout_sha}" ]; then
      : >"${ERROR_HUB_FAKE_STATE}/checkout-failed-once-${checkout_sha}"
      exit 1
    fi
    if [ "${ERROR_HUB_FAKE_CHECKOUT_FAIL_SHA:-}" = "${checkout_sha}" ]; then
      exit 1
    fi
    printf '%s\n' "${checkout_sha}" >"${ERROR_HUB_FAKE_STATE}/git-head"
    ;;
  *) ;;
esac
EOF

  cat >"${fixture_root}/fake-bin/docker" <<'EOF'
#!/bin/sh
printf 'docker ERROR_HUB_IMAGE=%s %s\n' "${ERROR_HUB_IMAGE:-}" "$*" >>"${ERROR_HUB_COMMAND_LOG}"
case "$1 $2 $3" in
  "info  "|"compose version ") exit 0 ;;
esac
if printf ' %s ' "$*" | grep -q ' compose .* ps -q sentrybox '; then
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
  printf '%s\n' 'ghcr.io/pbuchman/sentrybox@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
  exit 0
fi
if [ "$1" = rm ] && [ "${ERROR_HUB_FAKE_RESTORE_CLEANUP_FAIL:-0}" = 1 ]; then
  exit 1
fi
if [ "$1" = compose ]; then
  runtime_env="${ERROR_HUB_RUNTIME_ENV_FILE:-}"
  [ -n "${runtime_env}" ] && [ -f "${runtime_env}" ] || exit 1
  runtime_refs="$(sed -n 's/^ERROR_HUB_REQUIRED_SECRET_REFERENCES=//p' "${runtime_env}")"
  [ -n "${runtime_refs}" ] || exit 1
  printf 'docker RUNTIME_REFS=%s %s\n' "${runtime_refs}" "$*" >>"${ERROR_HUB_COMMAND_LOG}"
fi
if [ "$1" = run ]; then
  if printf '%s' "$*" | grep -q ' retained-finalize'; then
    retained_root="$(printf '%s\n' "$*" | sed -n 's/.*src=\([^,]*\),dst=\/retained.*/\1/p')"
    retained_name="$(printf '%s\n' "$*" | sed -n 's#.* retained-finalize /retained/\([^ ]*\)$#\1#p')"
    [ -n "${retained_root}" ] || exit 1
    [ -n "${retained_name}" ] || exit 1
    [ -f "${retained_root}/${retained_name}" ] || exit 1
    if [ "${ERROR_HUB_FAKE_RETAINED_CRASH:-0}" = 1 ] \
      && [ ! -e "${ERROR_HUB_FAKE_STATE}/retained-crashed" ]; then
      : >"${ERROR_HUB_FAKE_STATE}/retained-crashed"
      kill -KILL "${PPID}"
      exit 1
    fi
    [ "${ERROR_HUB_FAKE_RETAINED_FAIL:-0}" = 1 ] && exit 1
    exit 0
  fi
  if printf '%s' "$*" | grep -q 'synthetic-prepare'; then
    data_root="$(printf '%s\n' "$*" | sed -n 's#.*src=\([^,]*\),dst=/data.*#\1#p')"
    context_name="$(printf '%s\n' "$*" | sed -n 's#.* synthetic-prepare /data/\([^ ]*\)$#\1#p')"
    context_file="${data_root}/${context_name}"
    printf '%s\n' '{"version":1,"keyId":5,"projectId":1,"publicKey":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","dsn":"https://dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd@errors.intexuraos.cloud/1","eventId":"cccccccccccccccccccccccccccccccc","envelope":"synthetic-envelope"}' \
      >"${context_file}"
    chmod 0600 "${context_file}"
    case "${ERROR_HUB_FAKE_SYNTHETIC_PREPARE_AFTER_CONTEXT:-}" in
      exit) exit 1 ;;
      term) kill -TERM "$$" ;;
    esac
    cat "${context_file}"
    exit 0
  fi
  if printf '%s' "$*" | grep -q 'synthetic-verify'; then
    [ "${ERROR_HUB_FAKE_SYNTHETIC_VERIFY_FAIL:-0}" = 1 ] && exit 1
    exit 0
  fi
  if printf '%s' "$*" | grep -q 'synthetic-cleanup'; then
    data_root="$(printf '%s\n' "$*" | sed -n 's#.*src=\([^,]*\),dst=/data.*#\1#p')"
    context_name="$(printf '%s\n' "$*" | sed -n 's#.* synthetic-cleanup /data/\([^ ]*\)$#\1#p')"
    context_file="${data_root}/${context_name}"
    [ "${ERROR_HUB_FAKE_SYNTHETIC_CLEANUP_FAIL:-0}" = 1 ] && exit 1
    rm -f "${context_file}"
    exit 0
  fi
  if [ "${ERROR_HUB_FAKE_RESTORE_FAIL:-0}" = 1 ] && printf '%s' "$*" | grep -q ' restore-test'; then
    exit 1
  fi
  if printf '%s' "$*" | grep -q ' restore-test'; then
    restore_root="$(printf '%s\n' "$*" | sed -n 's/.*src=\([^,]*\),dst=\/restore.*/\1/p')"
    [ -n "${restore_root}" ] || exit 1
    [ -f "${restore_root}/restore.sqlite" ] || exit 1
    cp "${restore_root}/restore.sqlite" "${ERROR_HUB_FAKE_STATE}/restore-copy"
    if [ "${ERROR_HUB_FAKE_RESTORE_EXTRA:-0}" = 1 ]; then
      printf 'extra\n' >"${restore_root}/unexpected-artifact"
    fi
    exit 0
  fi
  if [ "${ERROR_HUB_FAKE_BACKUP_FAIL:-0}" = 1 ] && printf '%s' "$*" | grep -q ' online-backup'; then
    exit 1
  fi
  if printf '%s' "$*" | grep -q ' online-backup'; then
    backup_root="$(printf '%s\n' "$*" | sed -n 's/.*src=\([^,]*\),dst=\/backup.*/\1/p')"
    [ -n "${backup_root}" ] || exit 1
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
if [ "${ERROR_HUB_FAKE_READINESS_BLOCK:-0}" = 1 ]; then
  count=0
  [ -f "${ERROR_HUB_FAKE_STATE}/compose-up-count" ] && count="$(cat "${ERROR_HUB_FAKE_STATE}/compose-up-count")"
  if [ "${count}" -eq 1 ]; then
    : >"${ERROR_HUB_FAKE_STATE}/readiness-blocked"
    sleep 0.4
  fi
fi
if [ "${ERROR_HUB_FAKE_READINESS_FAIL:-0}" = 1 ]; then
  count=0
  [ -f "${ERROR_HUB_FAKE_STATE}/compose-up-count" ] && count="$(cat "${ERROR_HUB_FAKE_STATE}/compose-up-count")"
  [ "${count}" -eq 1 ] && exit 22
fi
headers_file=''
output_file=''
request_method='GET'
request_url=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --dump-header) headers_file="$2"; shift 2 ;;
    --output) output_file="$2"; shift 2 ;;
    --request) request_method="$2"; shift 2 ;;
    http://*|https://*) request_url="$1"; shift ;;
    *) shift ;;
  esac
done
case "${request_url}" in
  https://errors.intexuraos.cloud/api/*/envelope/*)
    if [ "${request_method}" = 'OPTIONS' ] \
      && [ "${ERROR_HUB_FAKE_PUBLIC_OPTIONS_FAIL:-0}" = 1 ]; then
      exit 22
    fi
    if [ "${request_method}" = 'POST' ] \
      && [ "${ERROR_HUB_FAKE_PUBLIC_POST_FAIL:-0}" = 1 ]; then
      exit 22
    fi
    ;;
esac
if printf '%s' "${request_url}" | grep -q '/api/1/envelope/'; then
  cors_origin='https://deployment-health.invalid'
  [ "${ERROR_HUB_FAKE_CORS_FAIL:-0}" = 1 ] && cors_origin='https://wrong.invalid'
  if [ "${request_method}" = 'OPTIONS' ]; then
    [ -z "${headers_file}" ] || printf '%s\n' \
      'HTTP/2 204' \
      "access-control-allow-origin: ${cors_origin}" \
      'access-control-allow-methods: POST, OPTIONS' \
      'access-control-allow-headers: Content-Type, Content-Encoding, X-Sentry-Auth' \
      >"${headers_file}"
    printf '204'
  else
    [ -z "${headers_file}" ] || printf '%s\n' \
      'HTTP/2 200' \
      "access-control-allow-origin: ${cors_origin}" \
      >"${headers_file}"
    [ -z "${output_file}" ] || printf '%s\n' \
      '{"id":"cccccccccccccccccccccccccccccccc"}' >"${output_file}"
    printf '200'
  fi
fi
exit 0
EOF

  cat >"${fixture_root}/fake-bin/mv" <<'EOF'
#!/bin/sh
for argument in "$@"; do destination="${argument}"; done
if [ "${ERROR_HUB_FAKE_STATE_WRITE_FAIL:-0}" = 1 ] \
  && printf '%s' "${destination}" | grep -q '/current.env$'; then
  exit 1
fi
exec /bin/mv "$@"
EOF

  cat >"${fixture_root}/fake-bin/rm" <<'EOF'
#!/bin/sh
for argument in "$@"; do
  case "${argument}" in
    */restore-test.[A-Za-z0-9]*)
      [ "${ERROR_HUB_FAKE_RESTORE_TREE_CLEANUP_FAIL:-0}" = 1 ] && exit 1
      ;;
    */.retained-finalize)
      [ "${ERROR_HUB_FAKE_RETAINED_CLEANUP_FAIL:-0}" = 1 ] && exit 1
      ;;
  esac
done
exec /bin/rm "$@"
EOF

  cat >"${fixture_root}/fake-bin/caddy" <<'EOF'
#!/bin/sh
printf 'caddy %s\n' "$*" >>"${ERROR_HUB_COMMAND_LOG}"
printf 'caddy-env XDG_CONFIG_HOME=%s XDG_DATA_HOME=%s\n' \
  "${XDG_CONFIG_HOME:-}" "${XDG_DATA_HOME:-}" >>"${ERROR_HUB_COMMAND_LOG}"
if [ "${ERROR_HUB_FAKE_MAINTENANCE_VALIDATE_FAIL:-0}" = 1 ] \
  && grep -q 'temporarily unavailable' \
    "${ERROR_HUB_TEST_ROOT}/etc/caddy/Caddyfile.d/sentrybox.caddy"; then
  exit 1
fi
if [ "${ERROR_HUB_FAKE_STAGED_CADDY_VERIFY_FAIL:-0}" = 1 ]; then
  case "${PWD}" in
    */install-assets.*/caddy) exit 1 ;;
  esac
fi
exit 0
EOF

  cat >"${fixture_root}/fake-bin/systemctl" <<'EOF'
#!/bin/sh
printf 'systemctl %s\n' "$*" >>"${ERROR_HUB_COMMAND_LOG}"
if [ "$1" = enable ]; then
  shift
  [ "$1" = --now ] || exit 65
  shift
  for unit in "$@"; do
    if [ "${ERROR_HUB_FAKE_TIMER_START_FAIL:-}" = "${unit}" ]; then
      exit 1
    fi
    : >"${ERROR_HUB_FAKE_STATE}/active-${unit}"
  done
  exit 0
fi
if [ "$1" = is-active ] && [ "$2" = --quiet ]; then
  [ -f "${ERROR_HUB_FAKE_STATE}/active-$3" ]
  exit
fi
if [ "$1" = list-timers ]; then
  for unit in "$@"; do :; done
  if [ "${ERROR_HUB_FAKE_TIMER_NEXT_DELAY_ONCE:-}" = "${unit}" ] \
    && [ ! -f "${ERROR_HUB_FAKE_STATE}/timer-next-delayed-${unit}" ]; then
    : >"${ERROR_HUB_FAKE_STATE}/timer-next-delayed-${unit}"
    exit 0
  fi
  [ "${ERROR_HUB_FAKE_TIMER_NEXT_MISSING:-}" = "${unit}" ] && exit 0
  [ -f "${ERROR_HUB_FAKE_STATE}/active-${unit}" ] || exit 0
  printf 'Wed 2026-07-29 12:00:00 CEST 4min left n/a n/a %s %s\n' \
    "${unit}" "${unit%.timer}.service"
  exit 0
fi
if [ "$*" = 'reload caddy' ]; then
  count_file="${ERROR_HUB_FAKE_STATE}/caddy-reload-count"
  count=0
  [ -f "${count_file}" ] && count="$(cat "${count_file}")"
  count=$((count + 1))
  printf '%s\n' "${count}" >"${count_file}"
  cp "${ERROR_HUB_TEST_ROOT}/etc/caddy/Caddyfile.d/sentrybox.caddy" \
    "${ERROR_HUB_FAKE_STATE}/caddy-reload-${count}.caddy"
  if [ "${ERROR_HUB_FAKE_CADDY_RESTORE_FAIL:-0}" = 1 ] \
    && [ "${count}" -ge 2 ]; then
    exit 1
  fi
fi
exit 0
EOF

  cat >"${fixture_root}/fake-bin/systemd-analyze" <<'EOF'
#!/bin/sh
printf 'systemd-analyze %s\n' "$*" >>"${ERROR_HUB_COMMAND_LOG}"
[ "${ERROR_HUB_FAKE_SYSTEMD_VERIFY_FAIL:-0}" = 1 ] && exit 1
exit 0
EOF

  cat >"${fixture_root}/fake-bin/sleep" <<'EOF'
#!/bin/sh
printf 'sleep %s\n' "$*" >>"${ERROR_HUB_COMMAND_LOG}"
if [ "$*" = 1 ]; then
  exit 0
fi
exec /bin/sleep "$@"
EOF

  for command in caddy systemctl systemd-analyze; do
    chmod +x "${fixture_root}/fake-bin/${command}"
  done

  chmod +x "${fixture_root}/fake-bin/"*
}

@test "install creates only the canonical Home Dev application paths with restrictive permissions" {
  run "${repository_root}/deploy/home-dev/install.sh" \
    --private-origin "${ERROR_HUB_PRIVATE_ORIGIN}"

  [ "${status}" -eq 0 ]
  [ -d "${fixture_root}/home/pbuchman/deploy/sentrybox" ]
  [ -f "${fixture_root}/home/pbuchman/services/sentrybox/env" ]
  [ -d "${fixture_root}/home/pbuchman/services/sentrybox/data" ]
  [ -d "${fixture_root}/home/pbuchman/services/sentrybox/backups" ]
  [ -d "${fixture_root}/home/pbuchman/services/sentrybox/deploy" ]
  [ "$(stat -c '%a' "${fixture_root}/home/pbuchman/services/sentrybox/env")" = 600 ]
  [ "$(stat -c '%a' "${fixture_root}/home/pbuchman/services/sentrybox/data")" = 700 ]
  [ "$(stat -c '%a' "${fixture_root}/home/pbuchman/services/sentrybox/backups")" = 700 ]
  [ "$(stat -c '%a' "${fixture_root}/home/pbuchman/services/sentrybox/deploy")" = 700 ]
  [ "$(stat -c '%u:%g' "${fixture_root}/home/pbuchman/services/sentrybox/deploy")" = '0:0' ]
  [ "$(stat -c '%a:%u:%g' "${fixture_root}/var/lib/sentrybox-deploy")" = '700:0:0' ]
  run find "${fixture_root}/home/pbuchman/services/sentrybox/deploy" -mindepth 1 -print
  [ "${status}" -eq 0 ]
  [ -z "${output}" ]
  [ -f "${fixture_root}/etc/caddy/Caddyfile.d/sentrybox.caddy" ]
  [ -f "${fixture_root}/etc/caddy/Caddyfile.d/sentrybox-deploy.caddy" ]
  [ "$(stat -c '%a' "${fixture_root}/etc/caddy/Caddyfile.d/sentrybox.caddy")" = 644 ]
  [ "$(stat -c '%a' "${fixture_root}/etc/caddy/Caddyfile.d/sentrybox-deploy.caddy")" = 644 ]
  cmp "${repository_root}/deploy/home-dev/caddy-sentrybox.caddy" \
    "${fixture_root}/etc/caddy/Caddyfile.d/sentrybox.caddy"
  cmp "${repository_root}/deploy/home-dev/caddy-sentrybox-deploy.caddy" \
    "${fixture_root}/etc/caddy/Caddyfile.d/sentrybox-deploy.caddy"
  [ -f "${fixture_root}/etc/systemd/system/sentrybox-deploy-webhook.service" ]
  [ -f "${fixture_root}/etc/systemd/system/sentrybox-deploy-bootstrap.service" ]
  [ -x "${repository_root}/deploy/home-dev/restore-test.sh" ]
  [ ! -e "${fixture_root}/etc/systemd/system/cloudflared.service" ]
  run grep -F 'systemd-analyze verify' "${ERROR_HUB_COMMAND_LOG}"
  [ "${status}" -eq 0 ]
  run grep -F "caddy validate --config ${fixture_root}/etc/caddy/Caddyfile" \
    "${ERROR_HUB_COMMAND_LOG}"
  [ "${status}" -eq 0 ]
  run grep -Fx \
    "caddy-env XDG_CONFIG_HOME=${fixture_root}/var/lib/sentrybox-deploy/caddy-validation/config XDG_DATA_HOME=${fixture_root}/var/lib/sentrybox-deploy/caddy-validation/data" \
    "${ERROR_HUB_COMMAND_LOG}"
  [ "${status}" -eq 0 ]
  run grep -F 'systemctl reload caddy' "${ERROR_HUB_COMMAND_LOG}"
  [ "${status}" -eq 0 ]
  caddy_validate_line="$(grep -n -F "caddy validate --config ${fixture_root}/etc/caddy/Caddyfile" \
    "${ERROR_HUB_COMMAND_LOG}" | cut -d: -f1)"
  caddy_reload_line="$(grep -n -F 'systemctl reload caddy' \
    "${ERROR_HUB_COMMAND_LOG}" | cut -d: -f1)"
  [ "${caddy_validate_line}" -lt "${caddy_reload_line}" ]
  run grep -E 'systemctl (enable|start).*sentrybox-deploy-webhook' \
    "${ERROR_HUB_COMMAND_LOG}"
  [ "${status}" -ne 0 ]
  run sh -c "find '${fixture_root}/home/pbuchman/services' -mindepth 1 -maxdepth 1 -print | sed 's#.*/##' | sort"
  [ "${status}" -eq 0 ]
  [ "${output}" = 'sentrybox' ]
}

@test "install requires the pinned root-owned system Node executable before publishing units" {
  node_binary="${fixture_root}/opt/nodejs/current/bin/node"
  rm -f "${node_binary}"

  run "${repository_root}/deploy/home-dev/install.sh" \
    --private-origin "${ERROR_HUB_PRIVATE_ORIGIN}"

  [ "${status}" -ne 0 ]
  [[ "${output}" == *"system Node.js v22.23.2"* ]]
  [ ! -e "${fixture_root}/etc/systemd/system/sentrybox-deploy-webhook.service" ]

  cat >"${node_binary}" <<'EOF'
#!/bin/sh
printf '%s\n' v22.23.0
EOF
  chmod 0755 "${node_binary}"

  run "${repository_root}/deploy/home-dev/install.sh" \
    --private-origin "${ERROR_HUB_PRIVATE_ORIGIN}"

  [ "${status}" -ne 0 ]
  [[ "${output}" == *"system Node.js v22.23.2"* ]]
  [ ! -e "${fixture_root}/etc/systemd/system/sentrybox-deploy-webhook.service" ]
}

@test "fresh installation requires exact service credentials before starting SentryBox" {
  credential_file="${fixture_root}/home/pbuchman/services/sentrybox/env"
  rm -f "${credential_file}"

  run "${repository_root}/deploy/home-dev/install.sh" \
    --private-origin "${ERROR_HUB_PRIVATE_ORIGIN}"

  [ "${status}" -ne 0 ]
  [[ "${output}" == *"must be created before installation"* ]]
  [ ! -e "${fixture_root}/etc/systemd/system/sentrybox.service" ]

  printf '%s\n' \
    'CODE_AGENT_HMAC_DEV=bootstrap-dev' \
    'CODE_AGENT_HMAC_PROD=bootstrap-prod' \
    >"${credential_file}"
  chmod 0600 "${credential_file}"

  run "${repository_root}/deploy/home-dev/install.sh" \
    --private-origin "${ERROR_HUB_PRIVATE_ORIGIN}"

  [ "${status}" -eq 0 ]
  [ -f "${fixture_root}/etc/systemd/system/sentrybox.service" ]
}

@test "install starts every operational timer and verifies its next activation" {
  run "${repository_root}/deploy/home-dev/install.sh" \
    --private-origin "${ERROR_HUB_PRIVATE_ORIGIN}"

  [ "${status}" -eq 0 ]
  for timer in \
    sentrybox-backup.timer \
    sentrybox-monitor.timer \
    sentrybox-restore-test.timer; do
    [ -f "${fixture_root}/fake-state/active-${timer}" ]
    grep -F "systemctl is-active --quiet ${timer}" "${ERROR_HUB_COMMAND_LOG}"
    grep -F "systemctl list-timers --all --no-legend --no-pager ${timer}" \
      "${ERROR_HUB_COMMAND_LOG}"
  done
}

@test "install waits for an immediate timer activation to expose its next activation" {
  export ERROR_HUB_FAKE_TIMER_NEXT_DELAY_ONCE=sentrybox-monitor.timer

  run "${repository_root}/deploy/home-dev/install.sh" \
    --private-origin "${ERROR_HUB_PRIVATE_ORIGIN}"

  [ "${status}" -eq 0 ]
  [ "$(grep -Fc \
    'systemctl list-timers --all --no-legend --no-pager sentrybox-monitor.timer' \
    "${ERROR_HUB_COMMAND_LOG}")" -eq 2 ]
}

@test "install fails when an operational timer did not start or has no next activation" {
  export ERROR_HUB_FAKE_TIMER_START_FAIL=sentrybox-monitor.timer
  run "${repository_root}/deploy/home-dev/install.sh" \
    --private-origin "${ERROR_HUB_PRIVATE_ORIGIN}"
  [ "${status}" -ne 0 ]

  unset ERROR_HUB_FAKE_TIMER_START_FAIL
  export ERROR_HUB_FAKE_TIMER_NEXT_MISSING=sentrybox-restore-test.timer
  run "${repository_root}/deploy/home-dev/install.sh" \
    --private-origin "${ERROR_HUB_PRIVATE_ORIGIN}"
  [ "${status}" -ne 0 ]
  [[ "${output}" == *"next activation"* ]]
  [ "$(grep -Fc \
    'systemctl list-timers --all --no-legend --no-pager sentrybox-restore-test.timer' \
    "${ERROR_HUB_COMMAND_LOG}")" -eq 36 ]
}

@test "install rejects a linked deployment state directory without mutating its target" {
  state_directory="${fixture_root}/var/lib/sentrybox-deploy"
  mv "${state_directory}" "${state_directory}.target"
  chmod 0755 "${state_directory}.target"
  ln -s "${state_directory}.target" "${state_directory}"

  run "${repository_root}/deploy/home-dev/install.sh" \
    --private-origin "${ERROR_HUB_PRIVATE_ORIGIN}"

  [ "${status}" -ne 0 ]
  [[ "${output}" == *"deployment state directory must be a regular directory"* ]]
  [ -L "${state_directory}" ]
  [ "$(stat -c '%a' "${state_directory}.target")" = 755 ]
}

@test "failed staged unit verification leaves installed unit and Caddy assets unchanged" {
  printf 'old-unit\n' \
    >"${fixture_root}/etc/systemd/system/sentrybox.service"
  printf 'old-caddy\n' \
    >"${fixture_root}/etc/caddy/Caddyfile.d/sentrybox.caddy"
  export ERROR_HUB_FAKE_SYSTEMD_VERIFY_FAIL=1

  run "${repository_root}/deploy/home-dev/install.sh" \
    --private-origin "${ERROR_HUB_PRIVATE_ORIGIN}"

  [ "${status}" -ne 0 ]
  [ "$(cat "${fixture_root}/etc/systemd/system/sentrybox.service")" = 'old-unit' ]
  [ "$(cat "${fixture_root}/etc/caddy/Caddyfile.d/sentrybox.caddy")" = 'old-caddy' ]
}

@test "failed staged full Caddy verification leaves installed assets unchanged" {
  printf 'old-unit\n' \
    >"${fixture_root}/etc/systemd/system/sentrybox.service"
  printf 'old-caddy\n' \
    >"${fixture_root}/etc/caddy/Caddyfile.d/sentrybox.caddy"
  export ERROR_HUB_FAKE_STAGED_CADDY_VERIFY_FAIL=1

  run "${repository_root}/deploy/home-dev/install.sh" \
    --private-origin "${ERROR_HUB_PRIVATE_ORIGIN}"

  [ "${status}" -ne 0 ]
  [ "$(cat "${fixture_root}/etc/systemd/system/sentrybox.service")" = 'old-unit' ]
  [ "$(cat "${fixture_root}/etc/caddy/Caddyfile.d/sentrybox.caddy")" = 'old-caddy' ]
  run grep -F 'caddy validate --config Caddyfile --adapter caddyfile' \
    "${ERROR_HUB_COMMAND_LOG}"
  [ "${status}" -eq 0 ]
}

@test "install creates and preserves the root-owned runtime reference state" {
  runtime_env="${fixture_root}/var/lib/sentrybox-deploy/runtime.env"
  rm -f "${runtime_env}"

  run "${repository_root}/deploy/home-dev/install.sh" \
    --private-origin "${ERROR_HUB_PRIVATE_ORIGIN}"

  [ "${status}" -eq 0 ]
  [ -f "${runtime_env}" ]
  [ "$(stat -c '%a' "${runtime_env}")" = 600 ]
  [ "$(stat -c '%u:%g' "${runtime_env}")" = '0:0' ]
  run grep -Fx \
    'ERROR_HUB_REQUIRED_SECRET_REFERENCES=CODE_AGENT_HMAC_DEV,CODE_AGENT_HMAC_PROD' \
    "${runtime_env}"
  [ "${status}" -eq 0 ]

  printf '%s\n' \
    'ERROR_HUB_REQUIRED_SECRET_REFERENCES=CODE_AGENT_HMAC_DEV,CODE_AGENT_HMAC_PROD' \
    'ERROR_HUB_GRAFANA_EXPLORE_URL=https://logs.example.grafana.net/explore?orgId=1&datasource=grafanacloud-logs' \
    >"${runtime_env}"
  chmod 0644 "${runtime_env}"

  run "${repository_root}/deploy/home-dev/install.sh" \
    --private-origin "${ERROR_HUB_PRIVATE_ORIGIN}"

  [ "${status}" -eq 0 ]
  [ "$(stat -c '%a' "${runtime_env}")" = 600 ]
  run grep -Fx \
    'ERROR_HUB_REQUIRED_SECRET_REFERENCES=CODE_AGENT_HMAC_DEV,CODE_AGENT_HMAC_PROD' \
    "${runtime_env}"
  [ "${status}" -eq 0 ]
  run grep -Fx \
    'ERROR_HUB_GRAFANA_EXPLORE_URL=https://logs.example.grafana.net/explore?orgId=1&datasource=grafanacloud-logs' \
    "${runtime_env}"
  [ "${status}" -eq 0 ]
}

@test "runtime state rejects an insecure Grafana Explore URL" {
  runtime_env="${fixture_root}/var/lib/sentrybox-deploy/runtime.env"
  printf '%s\n' \
    'ERROR_HUB_REQUIRED_SECRET_REFERENCES=CODE_AGENT_HMAC_DEV,CODE_AGENT_HMAC_PROD' \
    'ERROR_HUB_GRAFANA_EXPLORE_URL=http://logs.example.test/explore' \
    >"${runtime_env}"
  chmod 0600 "${runtime_env}"

  run "${repository_root}/deploy/home-dev/install.sh" \
    --private-origin "${ERROR_HUB_PRIVATE_ORIGIN}"

  [ "${status}" -ne 0 ]
  [[ "${output}" == *"Grafana Explore URL"* ]]
}

@test "runtime state rejects ambiguous Grafana Explore URL parameters and ports" {
  runtime_env="${fixture_root}/var/lib/sentrybox-deploy/runtime.env"
  for grafana_url in \
    'https://logs.example.test/explore?orgId=one&datasource=logs' \
    'https://logs.example.test/explore?orgId=1&orgId=2&datasource=logs' \
    'https://logs.example.test/explore?orgId=1&datasource=logs&extra=value' \
    'https://logs.example.test/explore?orgId=1&datasource=logs#fragment' \
    'https://logs.example.test:70000/explore?orgId=1&datasource=logs'; do
    printf '%s\n' \
      'ERROR_HUB_REQUIRED_SECRET_REFERENCES=CODE_AGENT_HMAC_DEV,CODE_AGENT_HMAC_PROD' \
      "ERROR_HUB_GRAFANA_EXPLORE_URL=${grafana_url}" \
      >"${runtime_env}"
    chmod 0600 "${runtime_env}"

    run "${repository_root}/deploy/home-dev/install.sh" \
      --private-origin "${ERROR_HUB_PRIVATE_ORIGIN}"

    [ "${status}" -ne 0 ]
    [[ "${output}" == *"Grafana Explore URL"* ]]
  done
}

@test "runtime state rejects legacy forwarding references after the full cutover" {
  runtime_env="${fixture_root}/var/lib/sentrybox-deploy/runtime.env"
  printf '%s\n' \
    'ERROR_HUB_REQUIRED_SECRET_REFERENCES=LEGACY_SENTRY_DSN_BACKEND_DEV,LEGACY_SENTRY_DSN_BACKEND_PROD' \
    >"${runtime_env}"
  chmod 0600 "${runtime_env}"

  run "${repository_root}/deploy/home-dev/install.sh" \
    --private-origin "${ERROR_HUB_PRIVATE_ORIGIN}"

  [ "${status}" -ne 0 ]
  [[ "${output}" == *"CODE_AGENT_HMAC_DEV,CODE_AGENT_HMAC_PROD"* ]]
}

@test "install and preflight reject invalid steady-state service credentials" {
  credential_file="${fixture_root}/home/pbuchman/services/sentrybox/env"
  image="ghcr.io/pbuchman/sentrybox@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

  for credentials in \
    $'LEGACY_SENTRY_DSN_BACKEND_DEV=redacted\nCODE_AGENT_HMAC_DEV=redacted\nCODE_AGENT_HMAC_PROD=redacted' \
    $'CODE_AGENT_HMAC_DEV=redacted\nCODE_AGENT_HMAC_PROD=redacted\nUNRELATED_SECRET=redacted' \
    $'CODE_AGENT_HMAC_DEV=redacted' \
    $'CODE_AGENT_HMAC_DEV=redacted\nCODE_AGENT_HMAC_DEV=again\nCODE_AGENT_HMAC_PROD=redacted' \
    $'CODE_AGENT_HMAC_DEV=\nCODE_AGENT_HMAC_PROD=redacted'; do
    printf '%s\n' "${credentials}" >"${credential_file}"
    chmod 0600 "${credential_file}"

    run "${repository_root}/deploy/home-dev/install.sh" \
      --private-origin "${ERROR_HUB_PRIVATE_ORIGIN}"
    [ "${status}" -ne 0 ]
    [[ "${output}" == *"service credential file"* ]]

    run "${repository_root}/deploy/home-dev/preflight.sh" "${image}"
    [ "${status}" -ne 0 ]
    [[ "${output}" == *"service credential file"* ]]
  done
}

@test "preflight refuses less than 15 GiB and immutable image violations" {
  export ERROR_HUB_FAKE_AVAILABLE_KIB=15728639
  run "${repository_root}/deploy/home-dev/preflight.sh" \
    "ghcr.io/pbuchman/sentrybox@sha256:$(printf 'b%.0s' $(seq 1 64))"
  [ "${status}" -ne 0 ]
  [[ "${output}" == *"15 GiB"* ]]

  export ERROR_HUB_FAKE_AVAILABLE_KIB=40000000
  run "${repository_root}/deploy/home-dev/preflight.sh"
  [ "${status}" -ne 0 ]
  [[ "${output}" == *"immutable"* ]]

  run "${repository_root}/deploy/home-dev/preflight.sh" \
    "ghcr.io/pbuchman/sentrybox:latest"
  [ "${status}" -ne 0 ]
  [[ "${output}" == *"immutable"* ]]
}

@test "preflight proves the container runtime UID can write the data mount" {
  run "${repository_root}/deploy/home-dev/preflight.sh" \
    "ghcr.io/pbuchman/sentrybox@sha256:$(printf 'b%.0s' $(seq 1 64))"

  [ "${status}" -eq 0 ]
  run grep -F 'runtime-write' "${ERROR_HUB_COMMAND_LOG}"
  [ "${status}" -eq 0 ]
}

@test "health checks exercise public CORS authenticated envelope parsing and persistence with cleanup" {
  image="ghcr.io/pbuchman/sentrybox@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  run bash -c ". '${repository_root}/deploy/home-dev/common.sh'; error_hub_health_checks '${ERROR_HUB_PRIVATE_ORIGIN}' '${image}'"

  [ "${status}" -eq 0 ]
  run grep -F 'OPTIONS --header Host: errors.intexuraos.cloud' \
    "${ERROR_HUB_COMMAND_LOG}"
  [ "${status}" -eq 0 ]
  run grep -F 'http://127.0.0.1:8140/api/1/envelope/?sentry_version=7&sentry_key=dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd' \
    "${ERROR_HUB_COMMAND_LOG}"
  [ "${status}" -eq 0 ]
  run grep -F 'Origin: https://deployment-health.invalid' "${ERROR_HUB_COMMAND_LOG}"
  [ "${status}" -eq 0 ]
  run grep -F 'X-Sentry-Auth: Sentry sentry_version=7' "${ERROR_HUB_COMMAND_LOG}"
  [ "${status}" -eq 0 ]
  run grep -F 'synthetic-verify' "${ERROR_HUB_COMMAND_LOG}"
  [ "${status}" -eq 0 ]
  run grep -F 'synthetic-cleanup' "${ERROR_HUB_COMMAND_LOG}"
  [ "${status}" -eq 0 ]
}

@test "synthetic database checks use the runtime identity without mounting deployment state" {
  image="ghcr.io/pbuchman/sentrybox@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

  run bash -c ". '${repository_root}/deploy/home-dev/common.sh'; error_hub_health_checks '${ERROR_HUB_PRIVATE_ORIGIN}' '${image}'"

  [ "${status}" -eq 0 ]
  run grep -F -- '--user 1000:1000' "${ERROR_HUB_COMMAND_LOG}"
  [ "${status}" -eq 0 ]
  run grep -F -- 'dst=/state' "${ERROR_HUB_COMMAND_LOG}"
  [ "${status}" -ne 0 ]
  run grep -E 'synthetic-(prepare|verify|cleanup) /data/synthetic-public-check\.[0-9]+\.json' \
    "${ERROR_HUB_COMMAND_LOG}"
  [ "${status}" -eq 0 ]
}

@test "synthetic database checks reject a root runtime identity before Docker" {
  export ERROR_HUB_RUNTIME_UID=0
  image="ghcr.io/pbuchman/sentrybox@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

  run bash -c ". '${repository_root}/deploy/home-dev/common.sh'; error_hub_synthetic_database_operation '${image}' synthetic-prepare /data/synthetic-public-check.1.json"

  [ "${status}" -ne 0 ]
  [[ "${output}" == *'numeric non-root runtime UID and GID'* ]]
  run grep -F 'synthetic-prepare' "${ERROR_HUB_COMMAND_LOG}"
  [ "${status}" -ne 0 ]
}

@test "failed synthetic persistence verification still removes the non-production fixture" {
  export ERROR_HUB_FAKE_SYNTHETIC_VERIFY_FAIL=1
  image="ghcr.io/pbuchman/sentrybox@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  run bash -c ". '${repository_root}/deploy/home-dev/common.sh'; error_hub_health_checks '${ERROR_HUB_PRIVATE_ORIGIN}' '${image}'"

  [ "${status}" -ne 0 ]
  verify_line="$(grep -n 'synthetic-verify' "${ERROR_HUB_COMMAND_LOG}" | tail -1 | cut -d: -f1)"
  cleanup_line="$(grep -n 'synthetic-cleanup' "${ERROR_HUB_COMMAND_LOG}" | tail -1 | cut -d: -f1)"
  [ -n "${verify_line}" ]
  [ -n "${cleanup_line}" ]
  [ "${verify_line}" -lt "${cleanup_line}" ]
}

@test "synthetic public check rejects an invalid CORS response and still cleans up" {
  export ERROR_HUB_FAKE_CORS_FAIL=1
  image="ghcr.io/pbuchman/sentrybox@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  run bash -c ". '${repository_root}/deploy/home-dev/common.sh'; error_hub_health_checks '${ERROR_HUB_PRIVATE_ORIGIN}' '${image}'"

  [ "${status}" -ne 0 ]
  run grep -F 'synthetic-cleanup' "${ERROR_HUB_COMMAND_LOG}"
  [ "${status}" -eq 0 ]
}

@test "synthetic cleanup failure preserves context and preflight recovers it before database validation" {
  export ERROR_HUB_FAKE_SYNTHETIC_CLEANUP_FAIL=1
  image="ghcr.io/pbuchman/sentrybox@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  run bash -c ". '${repository_root}/deploy/home-dev/common.sh'; error_hub_health_checks '${ERROR_HUB_PRIVATE_ORIGIN}' '${image}'"

  [ "${status}" -ne 0 ]
  context_file="$(find "${fixture_root}/home/pbuchman/services/sentrybox/data" \
    -maxdepth 1 -type f -name 'synthetic-public-check.[0-9]*.json' -print)"
  [ -f "${context_file}" ]
  printf 'live-database\n' \
    >"${fixture_root}/home/pbuchman/services/sentrybox/data/error-hub.sqlite"

  : >"${ERROR_HUB_COMMAND_LOG}"
  run "${repository_root}/deploy/home-dev/preflight.sh" "${image}"
  [ "${status}" -ne 0 ]
  [ -f "${context_file}" ]
  run grep -F 'synthetic-cleanup' "${ERROR_HUB_COMMAND_LOG}"
  [ "${status}" -eq 0 ]
  run grep -F 'sentrybox-check=preflight-integrity' "${ERROR_HUB_COMMAND_LOG}"
  [ "${status}" -ne 0 ]

  unset ERROR_HUB_FAKE_SYNTHETIC_CLEANUP_FAIL
  : >"${ERROR_HUB_COMMAND_LOG}"
  run "${repository_root}/deploy/home-dev/preflight.sh" "${image}"
  [ "${status}" -eq 0 ]
  [ ! -e "${context_file}" ]
  cleanup_line="$(grep -n 'synthetic-cleanup' "${ERROR_HUB_COMMAND_LOG}" | cut -d: -f1)"
  preflight_line="$(grep -n 'sentrybox-check=preflight-integrity' "${ERROR_HUB_COMMAND_LOG}" | cut -d: -f1)"
  [ -n "${cleanup_line}" ]
  [ -n "${preflight_line}" ]
  [ "${cleanup_line}" -lt "${preflight_line}" ]
}

@test "synthetic context is cleaned when prepare commits it before exit failure or TERM" {
  image="ghcr.io/pbuchman/sentrybox@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  for failure_mode in exit term; do
    export ERROR_HUB_FAKE_SYNTHETIC_PREPARE_AFTER_CONTEXT="${failure_mode}"
    : >"${ERROR_HUB_COMMAND_LOG}"

    run bash -c ". '${repository_root}/deploy/home-dev/common.sh'; error_hub_health_checks '${ERROR_HUB_PRIVATE_ORIGIN}' '${image}'"

    [ "${status}" -ne 0 ]
    run grep -F 'synthetic-cleanup' "${ERROR_HUB_COMMAND_LOG}"
    [ "${status}" -eq 0 ]
    run find "${fixture_root}/home/pbuchman/services/sentrybox/data" \
      -maxdepth 1 -type f -name 'synthetic-public-check.[0-9]*.json' -print
    [ -z "${output}" ]
  done
}

@test "deploy lock rejects contention before consuming the webhook request" {
  lock="${fixture_root}/run/lock/sentrybox-deploy.lock"
  exec 8>"${lock}"
  flock -n 8

  run "${repository_root}/deploy/home-dev/deploy.sh"

  [ "${status}" -ne 0 ]
  [[ "${output}" == *"already in progress"* ]]
  [ -f "${fixture_root}/var/lib/sentrybox-deploy/deploy-request.json" ]
}

@test "deploy marks only the canonical checkout as safe for root Git operations" {
  run "${repository_root}/deploy/home-dev/deploy.sh"

  [ "${status}" -eq 0 ]
  canonical_checkout="${fixture_root}/home/pbuchman/deploy/sentrybox"
  run grep -F "git -c safe.directory=${canonical_checkout} -C ${canonical_checkout} fetch --quiet origin main" \
    "${ERROR_HUB_COMMAND_LOG}"
  [ "${status}" -eq 0 ]
  run sh -c "grep '^git ' '${ERROR_HUB_COMMAND_LOG}' | grep -vF 'git -c safe.directory=${canonical_checkout} -C ${canonical_checkout} '"
  [ "${status}" -ne 0 ]
}

@test "deploy refuses a candidate before checkout when current state and canonical HEAD disagree" {
  deployed_sha='cccccccccccccccccccccccccccccccccccccccc'
  checkout_sha='dddddddddddddddddddddddddddddddddddddddd'
  write_runtime_state \
    'ghcr.io/pbuchman/sentrybox@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc' \
    "${deployed_sha}"
  printf '%s\n' "${checkout_sha}" >"${fixture_root}/fake-state/git-head"

  run "${repository_root}/deploy/home-dev/deploy.sh"

  [ "${status}" -ne 0 ]
  [[ "${output}" == *"does not match deployment state"* ]]
  [ "$(cat "${fixture_root}/fake-state/git-head")" = "${checkout_sha}" ]
  run grep -F "checkout --quiet --detach ${ERROR_HUB_EXPECTED_SHA}" \
    "${ERROR_HUB_COMMAND_LOG}"
  [ "${status}" -ne 0 ]
  run grep '^docker ERROR_HUB_IMAGE= pull ' "${ERROR_HUB_COMMAND_LOG}"
  [ "${status}" -ne 0 ]
}

@test "detached checkout preserves tracked modes under the private deployment umask" {
  canonical_checkout="${fixture_root}/home/pbuchman/deploy/sentrybox"
  real_path="${PATH#"${fixture_root}/fake-bin:"}"
  PATH="${real_path}" git -C "${canonical_checkout}" init --quiet
  PATH="${real_path}" git -C "${canonical_checkout}" \
    -c user.name='SentryBox Test' \
    -c user.email='sentrybox-test@example.invalid' \
    commit --quiet --allow-empty -m base
  base_sha="$(PATH="${real_path}" git -C "${canonical_checkout}" rev-parse HEAD)"

  printf '{}\n' >"${canonical_checkout}/tracked-config.json"
  printf '#!/bin/sh\nexit 0\n' >"${canonical_checkout}/tracked-script.sh"
  chmod 0644 "${canonical_checkout}/tracked-config.json"
  chmod 0755 "${canonical_checkout}/tracked-script.sh"
  PATH="${real_path}" git -C "${canonical_checkout}" add \
    tracked-config.json tracked-script.sh
  PATH="${real_path}" git -C "${canonical_checkout}" \
    -c user.name='SentryBox Test' \
    -c user.email='sentrybox-test@example.invalid' \
    commit --quiet -m assets
  assets_sha="$(PATH="${real_path}" git -C "${canonical_checkout}" rev-parse HEAD)"
  PATH="${real_path}" git -C "${canonical_checkout}" checkout --quiet --detach "${base_sha}"

  run env \
    ERROR_HUB_TEST_MODE=1 \
    ERROR_HUB_TEST_ROOT="${fixture_root}" \
    PATH="${real_path}" \
    bash -c "umask 077; source '${repository_root}/deploy/home-dev/common.sh'; error_hub_checkout_detached '${assets_sha}'"

  [ "${status}" -eq 0 ]
  [ "$(stat -c '%a' "${canonical_checkout}/tracked-config.json")" = 644 ]
  [ "$(stat -c '%a' "${canonical_checkout}/tracked-script.sh")" = 755 ]
}

@test "deploy and rollback use the mode-preserving checkout helper" {
  write_runtime_state
  canonical_checkout="${fixture_root}/home/pbuchman/deploy/sentrybox"
  printf 'live-database\n' \
    >"${fixture_root}/home/pbuchman/services/sentrybox/data/error-hub.sqlite"
  export ERROR_HUB_FAKE_BACKUP_FAIL=1

  run bash -c "umask 077; '${repository_root}/deploy/home-dev/deploy.sh'"

  [ "${status}" -ne 0 ]
  run grep -F \
    "git-umask 0022 -c safe.directory=${canonical_checkout} -C ${canonical_checkout} checkout --quiet --detach ${ERROR_HUB_EXPECTED_SHA}" \
    "${ERROR_HUB_COMMAND_LOG}"
  [ "${status}" -eq 0 ]
  run grep -F \
    "git-umask 0022 -c safe.directory=${canonical_checkout} -C ${canonical_checkout} checkout --quiet --detach ${ERROR_HUB_FAKE_HEAD_SHA}" \
    "${ERROR_HUB_COMMAND_LOG}"
  [ "${status}" -eq 0 ]
}

@test "root deployment repairs existing objects and creates fetched objects readable by the checkout owner" {
  canonical_checkout="${fixture_root}/home/pbuchman/deploy/sentrybox"
  existing_directory="${canonical_checkout}/.git/objects/aa"
  mkdir -p "${existing_directory}"
  printf 'existing-object\n' >"${existing_directory}/existing"
  chmod 0700 "${canonical_checkout}/.git/objects" "${existing_directory}"
  chmod 0400 "${existing_directory}/existing"
  export ERROR_HUB_FAKE_FETCH_OBJECT=1

  run "${repository_root}/deploy/home-dev/deploy.sh"

  [ "${status}" -eq 0 ]
  [ "$(stat -c '%a' "${canonical_checkout}/.git/objects")" = 755 ]
  [ "$(stat -c '%a' "${existing_directory}")" = 755 ]
  [ "$(stat -c '%a' "${existing_directory}/existing")" = 644 ]
  [ "$(stat -c '%a' "${canonical_checkout}/.git/objects/bb")" = 755 ]
  [ "$(stat -c '%a' "${canonical_checkout}/.git/objects/bb/fetched")" = 644 ]
  run grep -F \
    "git-umask 0022 -c safe.directory=${canonical_checkout} -C ${canonical_checkout} fetch --quiet origin main" \
    "${ERROR_HUB_COMMAND_LOG}"
  [ "${status}" -eq 0 ]
}

@test "deploy rejects wrong webhook identity and removes the claimed request" {
  printf '%s\n' \
    "{\"version\":1,\"repository\":\"attacker/repository\",\"workflow\":\"Release SentryBox Image\",\"headSha\":\"${ERROR_HUB_EXPECTED_SHA}\"}" \
    >"${fixture_root}/var/lib/sentrybox-deploy/deploy-request.json"

  run "${repository_root}/deploy/home-dev/deploy.sh"

  [ "${status}" -ne 0 ]
  [ ! -e "${fixture_root}/var/lib/sentrybox-deploy/deploy-request.json" ]
  run find "${fixture_root}/var/lib/sentrybox-deploy" -name 'deploy-request.processing.*' -print
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
  [ ! -e "${fixture_root}/var/lib/sentrybox-deploy/deploy-request.json" ]
}

@test "deploy claims and removes a request with invalid file metadata" {
  chmod 0644 "${fixture_root}/var/lib/sentrybox-deploy/deploy-request.json"

  run "${repository_root}/deploy/home-dev/deploy.sh"

  [ "${status}" -ne 0 ]
  [ ! -e "${fixture_root}/var/lib/sentrybox-deploy/deploy-request.json" ]
  run find "${fixture_root}/var/lib/sentrybox-deploy" -name 'deploy-request.processing.*' -print
  [ -z "${output}" ]
}

@test "terminated deployment removes its claimed request and reports signal failure" {
  export ERROR_HUB_FAKE_BLOCK_FETCH=1
  run bash -c '
    "$1" & deploy_pid=$!
    for _ in $(seq 1 200); do
      [ -f "$2" ] && break
      sleep 0.01
    done
    [ -f "$2" ] || { kill -TERM "${deploy_pid}"; wait "${deploy_pid}"; exit 1; }
    kill -TERM "${deploy_pid}"
    wait "${deploy_pid}"
  ' _ "${repository_root}/deploy/home-dev/deploy.sh" \
    "${fixture_root}/fake-state/fetch-blocked"

  [ "${status}" -eq 143 ]
  [ ! -e "${fixture_root}/var/lib/sentrybox-deploy/deploy-request.json" ]
  run find "${fixture_root}/var/lib/sentrybox-deploy" -name 'deploy-request.processing.*' -print
  [ -z "${output}" ]
}

@test "failed readiness automatically restores the previous digest before checking the database" {
  write_runtime_state
  printf 'live-database\n' \
    >"${fixture_root}/home/pbuchman/services/sentrybox/data/error-hub.sqlite"
  export ERROR_HUB_FAKE_READINESS_FAIL=1

  run "${repository_root}/deploy/home-dev/deploy.sh"

  [ "${status}" -ne 0 ]
  [ "$(cat "${fixture_root}/fake-state/compose-up-count")" -eq 2 ]
  first_previous="$(grep -n 'ERROR_HUB_IMAGE=ghcr.io/pbuchman/sentrybox@sha256:aaaaaaaa' "${ERROR_HUB_COMMAND_LOG}" | head -1 | cut -d: -f1)"
  first_integrity="$(grep -n 'rollback-integrity' "${ERROR_HUB_COMMAND_LOG}" | head -1 | cut -d: -f1)"
  [ -n "${first_previous}" ]
  [ -n "${first_integrity}" ]
  [ "${first_previous}" -lt "${first_integrity}" ]
  [ ! -e "${fixture_root}/var/lib/sentrybox-deploy/deploy-request.json" ]
  [ "$(cat "${fixture_root}/fake-state/git-head")" = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" ]
  grep -Fx 'ERROR_HUB_DEPLOYED_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' \
    "${fixture_root}/var/lib/sentrybox-deploy/current.env"
  rollback_checkout_line="$(
    grep -n 'checkout --quiet --detach aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' \
      "${ERROR_HUB_COMMAND_LOG}" | head -1 | cut -d: -f1
  )"
  rollback_restart_line="$(
    grep -n 'ERROR_HUB_IMAGE=ghcr.io/pbuchman/sentrybox@sha256:aaaaaaaa.*compose .* up -d --wait --remove-orphans' \
      "${ERROR_HUB_COMMAND_LOG}" | tail -1 | cut -d: -f1
  )"
  [ -n "${rollback_checkout_line}" ]
  [ -n "${rollback_restart_line}" ]
  [ "${rollback_checkout_line}" -lt "${rollback_restart_line}" ]
  [ "$(grep -Fc \
    "git -c safe.directory=${fixture_root}/home/pbuchman/deploy/sentrybox -C ${fixture_root}/home/pbuchman/deploy/sentrybox checkout --quiet --detach aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" \
    "${ERROR_HUB_COMMAND_LOG}")" -eq 1 ]
  run grep -F 'respond "temporarily unavailable" 503' \
    "${fixture_root}/etc/caddy/Caddyfile.d/sentrybox.caddy"
  [ "${status}" -ne 0 ]
}

@test "automatic rollback retries the complete reconciliation after a transient checkout failure" {
  previous_sha='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  write_runtime_state \
    'ghcr.io/pbuchman/sentrybox@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' \
    "${previous_sha}"
  printf 'live-database\n' \
    >"${fixture_root}/home/pbuchman/services/sentrybox/data/error-hub.sqlite"
  export ERROR_HUB_FAKE_READINESS_FAIL=1
  export ERROR_HUB_FAKE_CHECKOUT_FAIL_ONCE_SHA="${previous_sha}"

  run "${repository_root}/deploy/home-dev/deploy.sh"

  [ "${status}" -ne 0 ]
  [ "$(cat "${fixture_root}/fake-state/git-head")" = "${previous_sha}" ]
  grep -Fx "ERROR_HUB_DEPLOYED_SHA=${previous_sha}" \
    "${fixture_root}/var/lib/sentrybox-deploy/current.env"
  [ "$(cat "${fixture_root}/fake-state/compose-up-count")" -eq 2 ]
  [ "$(grep -Fc \
    "git -c safe.directory=${fixture_root}/home/pbuchman/deploy/sentrybox -C ${fixture_root}/home/pbuchman/deploy/sentrybox checkout --quiet --detach ${previous_sha}" \
    "${ERROR_HUB_COMMAND_LOG}")" -eq 2 ]
  run grep -F \
    'ERROR_HUB_IMAGE=ghcr.io/pbuchman/sentrybox@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa compose' \
    "${ERROR_HUB_COMMAND_LOG}"
  [ "${status}" -eq 0 ]
}

@test "automatic rollback stops the failed candidate and preserves prior state after persistent checkout failure" {
  previous_sha='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  candidate_sha="${ERROR_HUB_EXPECTED_SHA}"
  candidate_image='ghcr.io/pbuchman/sentrybox@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
  write_runtime_state \
    'ghcr.io/pbuchman/sentrybox@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' \
    "${previous_sha}"
  printf 'live-database\n' \
    >"${fixture_root}/home/pbuchman/services/sentrybox/data/error-hub.sqlite"
  export ERROR_HUB_FAKE_READINESS_FAIL=1
  export ERROR_HUB_FAKE_CHECKOUT_FAIL_SHA="${previous_sha}"

  run "${repository_root}/deploy/home-dev/deploy.sh"

  [ "${status}" -ne 0 ]
  [[ "${output}" == *'Automatic rollback reconciliation failed; the failed candidate was stopped'* ]]
  [ "$(cat "${fixture_root}/fake-state/git-head")" = "${candidate_sha}" ]
  grep -Fx "ERROR_HUB_DEPLOYED_SHA=${previous_sha}" \
    "${fixture_root}/var/lib/sentrybox-deploy/current.env"
  [ "$(cat "${fixture_root}/fake-state/compose-up-count")" -eq 1 ]
  run grep -F \
    "ERROR_HUB_IMAGE=${candidate_image} compose --file ${fixture_root}/home/pbuchman/deploy/sentrybox/deploy/home-dev/compose.yaml stop --timeout 30 sentrybox" \
    "${ERROR_HUB_COMMAND_LOG}"
  [ "${status}" -eq 0 ]
  run grep -F 'respond "temporarily unavailable" 503' \
    "${fixture_root}/etc/caddy/Caddyfile.d/sentrybox.caddy"
  [ "${status}" -eq 0 ]
}

@test "deploy rollback and direct rollback retain live secret references outside image state" {
  live_refs='CODE_AGENT_HMAC_DEV,CODE_AGENT_HMAC_PROD'
  printf 'ERROR_HUB_REQUIRED_SECRET_REFERENCES=%s\n' "${live_refs}" \
    >"${fixture_root}/var/lib/sentrybox-deploy/runtime.env"
  chmod 0600 "${fixture_root}/var/lib/sentrybox-deploy/runtime.env"
  write_runtime_state
  printf 'live-database\n' \
    >"${fixture_root}/home/pbuchman/services/sentrybox/data/error-hub.sqlite"
  export ERROR_HUB_FAKE_READINESS_FAIL=1

  run "${repository_root}/deploy/home-dev/deploy.sh"

  [ "${status}" -ne 0 ]
  [ "$(grep -c "docker RUNTIME_REFS=${live_refs} compose .* up -d --wait --remove-orphans" "${ERROR_HUB_COMMAND_LOG}")" -eq 2 ]
  [ "$(wc -l <"${fixture_root}/var/lib/sentrybox-deploy/current.env" | tr -d ' ')" -eq 3 ]
  run grep -F 'ERROR_HUB_REQUIRED_SECRET_REFERENCES' \
    "${fixture_root}/var/lib/sentrybox-deploy/current.env"
  [ "${status}" -ne 0 ]

  unset ERROR_HUB_FAKE_READINESS_FAIL
  run "${repository_root}/deploy/home-dev/rollback.sh"

  [ "${status}" -eq 0 ]
  [ "$(grep -c "docker RUNTIME_REFS=${live_refs} compose .* up -d --wait --remove-orphans" "${ERROR_HUB_COMMAND_LOG}")" -eq 3 ]
  [ "$(wc -l <"${fixture_root}/var/lib/sentrybox-deploy/previous.env" | tr -d ' ')" -eq 3 ]
}

@test "rollback keeps a healthy database and restores a backup only after a failed integrity check" {
  write_runtime_state
  cp "${fixture_root}/var/lib/sentrybox-deploy/current.env" \
    "${fixture_root}/var/lib/sentrybox-deploy/previous.env"
  printf 'live-database\n' \
    >"${fixture_root}/home/pbuchman/services/sentrybox/data/error-hub.sqlite"
  printf 'consistent-backup\n' \
    >"${fixture_root}/home/pbuchman/services/sentrybox/backups/predeploy.sqlite"

  run "${repository_root}/deploy/home-dev/rollback.sh"
  [ "${status}" -eq 0 ]
  [ "$(cat "${fixture_root}/home/pbuchman/services/sentrybox/data/error-hub.sqlite")" = 'live-database' ]

  export ERROR_HUB_FAKE_INTEGRITY_FAIL=1
  run "${repository_root}/deploy/home-dev/rollback.sh"
  [ "${status}" -eq 0 ]
  [ "$(cat "${fixture_root}/home/pbuchman/services/sentrybox/data/error-hub.sqlite")" = 'consistent-backup' ]
  [ "$(stat -c '%u:%g' "${fixture_root}/home/pbuchman/services/sentrybox/data/error-hub.sqlite")" = '1000:1000' ]
}

@test "operator rollback reconciles the canonical checkout, runtime, and current state to the previous release" {
  previous_sha='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  candidate_sha='cccccccccccccccccccccccccccccccccccccccc'
  previous_image='ghcr.io/pbuchman/sentrybox@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  candidate_image='ghcr.io/pbuchman/sentrybox@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'
  write_runtime_state "${previous_image}" "${previous_sha}"
  cp "${fixture_root}/var/lib/sentrybox-deploy/current.env" \
    "${fixture_root}/var/lib/sentrybox-deploy/previous.env"
  write_runtime_state "${candidate_image}" "${candidate_sha}"
  printf '%s\n' "${candidate_sha}" >"${fixture_root}/fake-state/git-head"

  run "${repository_root}/deploy/home-dev/rollback.sh"

  [ "${status}" -eq 0 ]
  [ "$(cat "${fixture_root}/fake-state/git-head")" = "${previous_sha}" ]
  grep -Fx "ERROR_HUB_DEPLOYED_SHA=${previous_sha}" \
    "${fixture_root}/var/lib/sentrybox-deploy/current.env"
  run grep -F "fetch --quiet origin main" "${ERROR_HUB_COMMAND_LOG}"
  [ "${status}" -eq 0 ]
  run grep -F "merge-base --is-ancestor ${previous_sha} origin/main" \
    "${ERROR_HUB_COMMAND_LOG}"
  [ "${status}" -eq 0 ]
  run grep -F "checkout --quiet --detach ${previous_sha}" \
    "${ERROR_HUB_COMMAND_LOG}"
  [ "${status}" -eq 0 ]
  run grep -F "ERROR_HUB_IMAGE=${previous_image} compose" \
    "${ERROR_HUB_COMMAND_LOG}"
  [ "${status}" -eq 0 ]
}

@test "rollback refuses a previous SHA that is not reachable from canonical origin main" {
  previous_sha='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  candidate_sha='cccccccccccccccccccccccccccccccccccccccc'
  previous_image='ghcr.io/pbuchman/sentrybox@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  candidate_image='ghcr.io/pbuchman/sentrybox@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'
  write_runtime_state "${previous_image}" "${previous_sha}"
  cp "${fixture_root}/var/lib/sentrybox-deploy/current.env" \
    "${fixture_root}/var/lib/sentrybox-deploy/previous.env"
  write_runtime_state "${candidate_image}" "${candidate_sha}"
  printf '%s\n' "${candidate_sha}" >"${fixture_root}/fake-state/git-head"
  export ERROR_HUB_FAKE_NON_CANONICAL_SHA="${previous_sha}"

  run "${repository_root}/deploy/home-dev/rollback.sh"

  [ "${status}" -ne 0 ]
  [[ "${output}" == *"not reachable from canonical origin/main"* ]]
  [ "$(cat "${fixture_root}/fake-state/git-head")" = "${candidate_sha}" ]
  grep -Fx "ERROR_HUB_DEPLOYED_SHA=${candidate_sha}" \
    "${fixture_root}/var/lib/sentrybox-deploy/current.env"
  [ ! -e "${fixture_root}/fake-state/compose-up-count" ]
}

@test "operator rollback requires current state to match the canonical checkout" {
  previous_sha='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  candidate_sha='cccccccccccccccccccccccccccccccccccccccc'
  write_runtime_state \
    'ghcr.io/pbuchman/sentrybox@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' \
    "${previous_sha}"
  cp "${fixture_root}/var/lib/sentrybox-deploy/current.env" \
    "${fixture_root}/var/lib/sentrybox-deploy/previous.env"
  printf '%s\n' "${candidate_sha}" >"${fixture_root}/fake-state/git-head"

  run "${repository_root}/deploy/home-dev/rollback.sh"

  [ "${status}" -ne 0 ]
  [[ "${output}" == *"does not match deployment state"* ]]
  [ ! -e "${fixture_root}/fake-state/compose-up-count" ]
  [ "$(cat "${fixture_root}/fake-state/git-head")" = "${candidate_sha}" ]
}

@test "rollback leaves the running release and state untouched when previous checkout reconciliation fails" {
  previous_sha='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  candidate_sha='cccccccccccccccccccccccccccccccccccccccc'
  previous_image='ghcr.io/pbuchman/sentrybox@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  candidate_image='ghcr.io/pbuchman/sentrybox@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'
  write_runtime_state "${previous_image}" "${previous_sha}"
  cp "${fixture_root}/var/lib/sentrybox-deploy/current.env" \
    "${fixture_root}/var/lib/sentrybox-deploy/previous.env"
  write_runtime_state "${candidate_image}" "${candidate_sha}"
  printf '%s\n' "${candidate_sha}" >"${fixture_root}/fake-state/git-head"
  export ERROR_HUB_FAKE_CHECKOUT_FAIL_SHA="${previous_sha}"

  run "${repository_root}/deploy/home-dev/rollback.sh"

  [ "${status}" -ne 0 ]
  [ "$(cat "${fixture_root}/fake-state/git-head")" = "${candidate_sha}" ]
  grep -Fx "ERROR_HUB_DEPLOYED_SHA=${candidate_sha}" \
    "${fixture_root}/var/lib/sentrybox-deploy/current.env"
  [ ! -e "${fixture_root}/fake-state/compose-up-count" ]
}

@test "rollback restores the previously deployed runtime and HEAD when the target runtime cannot start" {
  previous_sha='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  candidate_sha='cccccccccccccccccccccccccccccccccccccccc'
  previous_image='ghcr.io/pbuchman/sentrybox@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  candidate_image='ghcr.io/pbuchman/sentrybox@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'
  write_runtime_state "${previous_image}" "${previous_sha}"
  cp "${fixture_root}/var/lib/sentrybox-deploy/current.env" \
    "${fixture_root}/var/lib/sentrybox-deploy/previous.env"
  write_runtime_state "${candidate_image}" "${candidate_sha}"
  printf '%s\n' "${candidate_sha}" >"${fixture_root}/fake-state/git-head"
  export ERROR_HUB_FAKE_UP_FAIL=1

  run "${repository_root}/deploy/home-dev/rollback.sh"

  [ "${status}" -ne 0 ]
  [ "$(cat "${fixture_root}/fake-state/git-head")" = "${candidate_sha}" ]
  grep -Fx "ERROR_HUB_DEPLOYED_SHA=${candidate_sha}" \
    "${fixture_root}/var/lib/sentrybox-deploy/current.env"
  [ "$(cat "${fixture_root}/fake-state/compose-up-count")" -eq 2 ]
  run grep -F "ERROR_HUB_IMAGE=${candidate_image} compose" \
    "${ERROR_HUB_COMMAND_LOG}"
  [ "${status}" -eq 0 ]
}

@test "rollback restores the original checkout runtime and state after previous health failure" {
  previous_sha='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  candidate_sha='cccccccccccccccccccccccccccccccccccccccc'
  previous_image='ghcr.io/pbuchman/sentrybox@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  candidate_image='ghcr.io/pbuchman/sentrybox@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'
  write_runtime_state "${previous_image}" "${previous_sha}"
  cp "${fixture_root}/var/lib/sentrybox-deploy/current.env" \
    "${fixture_root}/var/lib/sentrybox-deploy/previous.env"
  write_runtime_state "${candidate_image}" "${candidate_sha}"
  printf '%s\n' "${candidate_sha}" >"${fixture_root}/fake-state/git-head"
  export ERROR_HUB_FAKE_READINESS_FAIL=1

  run "${repository_root}/deploy/home-dev/rollback.sh"

  [ "${status}" -ne 0 ]
  [ "$(cat "${fixture_root}/fake-state/git-head")" = "${candidate_sha}" ]
  grep -Fx "ERROR_HUB_DEPLOYED_SHA=${candidate_sha}" \
    "${fixture_root}/var/lib/sentrybox-deploy/current.env"
  [ "$(cat "${fixture_root}/fake-state/compose-up-count")" -eq 2 ]
  previous_restart_line="$(
    grep -n "ERROR_HUB_IMAGE=${previous_image} compose" \
      "${ERROR_HUB_COMMAND_LOG}" | head -1 | cut -d: -f1
  )"
  original_checkout_line="$(
    grep -n "checkout --quiet --detach ${candidate_sha}" \
      "${ERROR_HUB_COMMAND_LOG}" | tail -1 | cut -d: -f1
  )"
  original_restart_line="$(
    grep -n "ERROR_HUB_IMAGE=${candidate_image} compose" \
      "${ERROR_HUB_COMMAND_LOG}" | tail -1 | cut -d: -f1
  )"
  [ -n "${previous_restart_line}" ]
  [ -n "${original_checkout_line}" ]
  [ -n "${original_restart_line}" ]
  [ "${previous_restart_line}" -lt "${original_checkout_line}" ]
  [ "${original_checkout_line}" -lt "${original_restart_line}" ]
}

@test "direct rollback rejects unsafe persistent runtime reference metadata" {
  write_runtime_state
  cp "${fixture_root}/var/lib/sentrybox-deploy/current.env" \
    "${fixture_root}/var/lib/sentrybox-deploy/previous.env"
  runtime_env="${fixture_root}/var/lib/sentrybox-deploy/runtime.env"

  chmod 0644 "${runtime_env}"
  run "${repository_root}/deploy/home-dev/rollback.sh"
  [ "${status}" -ne 0 ]
  [ ! -e "${fixture_root}/fake-state/compose-up-count" ]

  chmod 0600 "${runtime_env}"
  mv "${runtime_env}" "${runtime_env}.real"
  ln -s "${runtime_env}.real" "${runtime_env}"
  run "${repository_root}/deploy/home-dev/rollback.sh"
  [ "${status}" -ne 0 ]
  [ ! -e "${fixture_root}/fake-state/compose-up-count" ]
}

@test "direct rollback rejects permissive or multiply linked deployment state" {
  write_runtime_state
  cp "${fixture_root}/var/lib/sentrybox-deploy/current.env" \
    "${fixture_root}/var/lib/sentrybox-deploy/previous.env"

  chmod 0644 "${fixture_root}/var/lib/sentrybox-deploy/previous.env"
  run "${repository_root}/deploy/home-dev/rollback.sh"
  [ "${status}" -ne 0 ]
  [[ "${output}" == *"Deployment state must be root-owned, mode 0600, and singly linked"* ]]
  [ ! -e "${fixture_root}/fake-state/compose-up-count" ]

  rm "${fixture_root}/var/lib/sentrybox-deploy/previous.env"
  ln "${fixture_root}/var/lib/sentrybox-deploy/current.env" \
    "${fixture_root}/var/lib/sentrybox-deploy/previous.env"
  run "${repository_root}/deploy/home-dev/rollback.sh"
  [ "${status}" -ne 0 ]
  [[ "${output}" == *"Deployment state must be root-owned, mode 0600, and singly linked"* ]]
  [ ! -e "${fixture_root}/fake-state/compose-up-count" ]
}

@test "predeploy backup uses SQLite online backup and removes unknown snapshots" {
  write_runtime_state
  printf 'live-database\n' \
    >"${fixture_root}/home/pbuchman/services/sentrybox/data/error-hub.sqlite"
  printf 'stale\n' \
    >"${fixture_root}/home/pbuchman/services/sentrybox/backups/old.sqlite"

  run "${repository_root}/deploy/home-dev/backup.sh" predeploy \
    "ghcr.io/pbuchman/sentrybox@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

  [ "${status}" -eq 0 ]
  [ -s "${fixture_root}/home/pbuchman/services/sentrybox/backups/predeploy.sqlite" ]
  [ ! -e "${fixture_root}/home/pbuchman/services/sentrybox/backups/old.sqlite" ]
  [ "$(find "${fixture_root}/home/pbuchman/services/sentrybox/backups" -maxdepth 1 -name '*.sqlite' | wc -l | tr -d ' ')" -eq 1 ]
  run grep -F 'online-backup' "${ERROR_HUB_COMMAND_LOG}"
  [ "${status}" -eq 0 ]
  run grep -E '(^| )cp .*/data/error-hub.sqlite' "${ERROR_HUB_COMMAND_LOG}"
  [ "${status}" -ne 0 ]
}

@test "scheduled backup re-scrubs the retained snapshot before reporting the missing target" {
  write_runtime_state
  printf 'live-database\n' \
    >"${fixture_root}/home/pbuchman/services/sentrybox/data/error-hub.sqlite"
  printf 'predeploy-good\n' \
    >"${fixture_root}/home/pbuchman/services/sentrybox/backups/predeploy.sqlite"

  run "${repository_root}/deploy/home-dev/backup.sh" scheduled

  [ "${status}" -ne 0 ]
  [[ "${output}" == *"disabled/degraded"* ]]
  [ "$(cat "${fixture_root}/home/pbuchman/services/sentrybox/backups/predeploy.sqlite")" = 'predeploy-good' ]
  [ ! -e "${fixture_root}/home/pbuchman/services/sentrybox/backups/scheduled.sqlite" ]
  run grep -F 'retained-finalize' "${ERROR_HUB_COMMAND_LOG}"
  [ "${status}" -eq 0 ]
  run grep -F -- '--user 1000:1000' "${ERROR_HUB_COMMAND_LOG}"
  [ "${status}" -eq 0 ]
  [ "$(stat -c '%u:%g' "${fixture_root}/home/pbuchman/services/sentrybox/backups/predeploy.sqlite")" = '1000:1000' ]
  backup_state="${fixture_root}/var/lib/sentrybox-deploy/backup.state"
  [ "$(stat -c '%a:%u:%g:%h' "${backup_state}")" = '600:0:0:1' ]
  grep -Fx 'EXTERNAL_STATUS=disabled_degraded' "${backup_state}"
  grep -Fx 'EXTERNAL_REASON=no_external_target' "${backup_state}"
  grep -Fx 'LOCAL_SCRUB_STATUS=success' "${backup_state}"
  grep -Fx 'LOCAL_SCRUB_REASON=none' "${backup_state}"
  [ ! -e "${fixture_root}/var/lib/sentrybox-deploy/backup.success" ]
  run grep -F "src=${fixture_root}/home/pbuchman/services/sentrybox/backups/.retained-finalize,dst=/retained" \
    "${ERROR_HUB_COMMAND_LOG}"
  [ "${status}" -eq 0 ]
  run grep -F "src=${fixture_root}/home/pbuchman/services/sentrybox/backups,dst=/retained" \
    "${ERROR_HUB_COMMAND_LOG}"
  [ "${status}" -ne 0 ]
}

@test "scheduled backup without a retained snapshot still reports external backup degraded" {
  write_runtime_state

  run "${repository_root}/deploy/home-dev/backup.sh" scheduled

  [ "${status}" -ne 0 ]
  [[ "${output}" == *"disabled/degraded"* ]]
  [[ "${output}" == *"no retained snapshot"* ]]
  backup_state="${fixture_root}/var/lib/sentrybox-deploy/backup.state"
  grep -Fx 'EXTERNAL_STATUS=disabled_degraded' "${backup_state}"
  grep -Fx 'LOCAL_SCRUB_STATUS=failure' "${backup_state}"
  grep -Fx 'LOCAL_SCRUB_REASON=retained_snapshot_invalid' "${backup_state}"
}

@test "scheduled backup does not scrub the rollback snapshot while deployment holds the lock" {
  write_runtime_state
  printf 'predeploy-good\n' \
    >"${fixture_root}/home/pbuchman/services/sentrybox/backups/predeploy.sqlite"
  exec 8>"${fixture_root}/run/lock/sentrybox-deploy.lock"
  flock -n 8

  run "${repository_root}/deploy/home-dev/backup.sh" scheduled

  flock -u 8
  exec 8>&-
  [ "${status}" -ne 0 ]
  [[ "${output}" == *"disabled/degraded"* ]]
  [ "$(cat "${fixture_root}/home/pbuchman/services/sentrybox/backups/predeploy.sqlite")" = 'predeploy-good' ]
  run grep -F 'retained-finalize' "${ERROR_HUB_COMMAND_LOG}"
  [ "${status}" -ne 0 ]
  backup_state="${fixture_root}/var/lib/sentrybox-deploy/backup.state"
  grep -Fx 'LOCAL_SCRUB_STATUS=failure' "${backup_state}"
  grep -Fx 'LOCAL_SCRUB_REASON=lock_unavailable' "${backup_state}"
}

@test "scheduled backup recovers a validated retained-finalize staging tree after interruption" {
  write_runtime_state
  printf 'predeploy-good\n' \
    >"${fixture_root}/home/pbuchman/services/sentrybox/backups/predeploy.sqlite"
  export ERROR_HUB_FAKE_RETAINED_CRASH=1

  run "${repository_root}/deploy/home-dev/backup.sh" scheduled

  [ "${status}" -ne 0 ]
  staging="${fixture_root}/home/pbuchman/services/sentrybox/backups/.retained-finalize"
  [ -d "${staging}" ]
  [ -f "${staging}/.retained.sqlite.COPY000" ]

  unset ERROR_HUB_FAKE_RETAINED_CRASH
  run "${repository_root}/deploy/home-dev/backup.sh" scheduled

  [ "${status}" -ne 0 ]
  [[ "${output}" == *"no external Home Dev backup target"* ]]
  [ ! -e "${staging}" ]
  backup_state="${fixture_root}/var/lib/sentrybox-deploy/backup.state"
  grep -Fx 'LOCAL_SCRUB_STATUS=success' "${backup_state}"
  grep -Fx 'LOCAL_SCRUB_REASON=none' "${backup_state}"
}

@test "scheduled backup recovers exactly an empty root-owned retained-finalize directory left before ownership transfer" {
  write_runtime_state
  printf 'predeploy-good\n' \
    >"${fixture_root}/home/pbuchman/services/sentrybox/backups/predeploy.sqlite"
  staging="${fixture_root}/home/pbuchman/services/sentrybox/backups/.retained-finalize"
  install -d -o 0 -g 0 -m 0700 "${staging}"
  printf 'preserve-me\n' >"${staging}/unexpected"
  chmod 0600 "${staging}/unexpected"

  run "${repository_root}/deploy/home-dev/backup.sh" scheduled

  [ "${status}" -ne 0 ]
  [[ "${output}" == *"unsafe retained-finalize staging"* ]]
  [ "$(cat "${staging}/unexpected")" = preserve-me ]

  rm "${staging}/unexpected"
  run "${repository_root}/deploy/home-dev/backup.sh" scheduled

  [ "${status}" -ne 0 ]
  [[ "${output}" == *"no external Home Dev backup target"* ]]
  [ ! -e "${staging}" ]
  backup_state="${fixture_root}/var/lib/sentrybox-deploy/backup.state"
  grep -Fx 'LOCAL_SCRUB_STATUS=success' "${backup_state}"
  grep -Fx 'LOCAL_SCRUB_REASON=none' "${backup_state}"
}

@test "scheduled backup refuses an unsafe retained-finalize staging tree without deleting it" {
  write_runtime_state
  printf 'predeploy-good\n' \
    >"${fixture_root}/home/pbuchman/services/sentrybox/backups/predeploy.sqlite"
  staging="${fixture_root}/home/pbuchman/services/sentrybox/backups/.retained-finalize"
  install -d -o 1000 -g 1000 -m 0700 "${staging}"
  printf 'preserve-me\n' >"${staging}/unexpected"
  chown 1000:1000 "${staging}/unexpected"
  chmod 0600 "${staging}/unexpected"

  run "${repository_root}/deploy/home-dev/backup.sh" scheduled

  [ "${status}" -ne 0 ]
  [[ "${output}" == *"unsafe retained-finalize staging"* ]]
  [ "$(cat "${staging}/unexpected")" = preserve-me ]
  backup_state="${fixture_root}/var/lib/sentrybox-deploy/backup.state"
  grep -Fx 'LOCAL_SCRUB_STATUS=failure' "${backup_state}"
  grep -Fx 'LOCAL_SCRUB_REASON=retained_scrub_failed' "${backup_state}"
}

@test "scheduled backup reports retained-finalize staging cleanup failure" {
  write_runtime_state
  printf 'predeploy-good\n' \
    >"${fixture_root}/home/pbuchman/services/sentrybox/backups/predeploy.sqlite"
  export ERROR_HUB_FAKE_RETAINED_CLEANUP_FAIL=1

  run "${repository_root}/deploy/home-dev/backup.sh" scheduled

  [ "${status}" -ne 0 ]
  [[ "${output}" == *"staging cleanup failed"* ]]
  backup_state="${fixture_root}/var/lib/sentrybox-deploy/backup.state"
  grep -Fx 'LOCAL_SCRUB_STATUS=failure' "${backup_state}"
  grep -Fx 'LOCAL_SCRUB_REASON=retained_scrub_failed' "${backup_state}"
}

@test "scheduled backup records a retained snapshot scrub failure" {
  write_runtime_state
  printf 'corrupt-retained-snapshot\n' \
    >"${fixture_root}/home/pbuchman/services/sentrybox/backups/predeploy.sqlite"
  export ERROR_HUB_FAKE_RETAINED_FAIL=1

  run "${repository_root}/deploy/home-dev/backup.sh" scheduled

  [ "${status}" -ne 0 ]
  [[ "${output}" == *"retained snapshot scrub failed"* ]]
  backup_state="${fixture_root}/var/lib/sentrybox-deploy/backup.state"
  grep -Fx 'EXTERNAL_STATUS=disabled_degraded' "${backup_state}"
  grep -Fx 'LOCAL_SCRUB_STATUS=failure' "${backup_state}"
  grep -Fx 'LOCAL_SCRUB_REASON=retained_scrub_failed' "${backup_state}"
}

@test "restore test validates a private copy with the current runtime and never mounts live data" {
  write_runtime_state
  printf 'live-database\n' \
    >"${fixture_root}/home/pbuchman/services/sentrybox/data/error-hub.sqlite"
  printf 'predeploy-good\n' \
    >"${fixture_root}/home/pbuchman/services/sentrybox/backups/predeploy.sqlite"

  run "${repository_root}/deploy/home-dev/restore-test.sh"

  [ "${status}" -eq 0 ]
  [ "$(cat "${fixture_root}/fake-state/restore-copy")" = 'predeploy-good' ]
  [ "$(cat "${fixture_root}/home/pbuchman/services/sentrybox/data/error-hub.sqlite")" = 'live-database' ]
  [ "$(cat "${fixture_root}/home/pbuchman/services/sentrybox/backups/predeploy.sqlite")" = 'predeploy-good' ]
  [ -f "${fixture_root}/var/lib/sentrybox-deploy/restore-test.success" ]
  [ "$(stat -c '%a:%u:%g:%h' "${fixture_root}/var/lib/sentrybox-deploy/restore-test.success")" = '600:0:0:1' ]
  run grep -F 'ghcr.io/pbuchman/sentrybox@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' \
    "${ERROR_HUB_COMMAND_LOG}"
  [ "${status}" -eq 0 ]
  run grep -F 'dst=/restore' "${ERROR_HUB_COMMAND_LOG}"
  [ "${status}" -eq 0 ]
  run grep -F 'restore-test' "${ERROR_HUB_COMMAND_LOG}"
  [ "${status}" -eq 0 ]
  run grep -F -- '--network none' "${ERROR_HUB_COMMAND_LOG}"
  [ "${status}" -eq 0 ]
  run grep -E '(dst=/data|services/sentrybox/data|--env-file|/run/secrets)' \
    "${ERROR_HUB_COMMAND_LOG}"
  [ "${status}" -ne 0 ]
  run find "${fixture_root}/var/lib/sentrybox-deploy" -maxdepth 1 \
    -type d -name 'restore-test.*' -print
  [ "${status}" -eq 0 ]
  [ -z "${output}" ]
}

@test "restore test does not capture state or backup while deployment owns the lock" {
  write_runtime_state
  printf 'predeploy-good\n' \
    >"${fixture_root}/home/pbuchman/services/sentrybox/backups/predeploy.sqlite"
  exec 8>"${fixture_root}/run/lock/sentrybox-deploy.lock"
  flock -n 8

  run "${repository_root}/deploy/home-dev/restore-test.sh"

  flock -u 8
  exec 8>&-
  [ "${status}" -ne 0 ]
  [[ "${output}" == *"deployment or backup is active"* ]]
  run grep -F ' restore-test' "${ERROR_HUB_COMMAND_LOG}"
  [ "${status}" -ne 0 ]
}

@test "failed restore test cleans its private copy without changing live data or the backup" {
  write_runtime_state
  printf 'live-database\n' \
    >"${fixture_root}/home/pbuchman/services/sentrybox/data/error-hub.sqlite"
  printf 'predeploy-good\n' \
    >"${fixture_root}/home/pbuchman/services/sentrybox/backups/predeploy.sqlite"
  export ERROR_HUB_FAKE_RESTORE_FAIL=1

  run "${repository_root}/deploy/home-dev/restore-test.sh"

  [ "${status}" -ne 0 ]
  [ "$(cat "${fixture_root}/home/pbuchman/services/sentrybox/data/error-hub.sqlite")" = 'live-database' ]
  [ "$(cat "${fixture_root}/home/pbuchman/services/sentrybox/backups/predeploy.sqlite")" = 'predeploy-good' ]
  run find "${fixture_root}/var/lib/sentrybox-deploy" -maxdepth 1 \
    -type d -name 'restore-test.*' -print
  [ "${status}" -eq 0 ]
  [ -z "${output}" ]
}

@test "restore test removes an unexpected bounded artifact and its named container" {
  write_runtime_state
  printf 'predeploy-good\n' \
    >"${fixture_root}/home/pbuchman/services/sentrybox/backups/predeploy.sqlite"
  export ERROR_HUB_FAKE_RESTORE_EXTRA=1

  run "${repository_root}/deploy/home-dev/restore-test.sh"

  [ "${status}" -eq 0 ]
  run find "${fixture_root}/var/lib/sentrybox-deploy" -maxdepth 1 \
    -type d -name 'restore-test.*' -print
  [ "${status}" -eq 0 ]
  [ -z "${output}" ]
  run grep -E 'docker ERROR_HUB_IMAGE=.* rm --force sentrybox-restore-test-' \
    "${ERROR_HUB_COMMAND_LOG}"
  [ "${status}" -eq 0 ]
}

@test "restore test reports container cleanup failure instead of claiming success" {
  write_runtime_state
  printf 'predeploy-good\n' \
    >"${fixture_root}/home/pbuchman/services/sentrybox/backups/predeploy.sqlite"
  marker="${fixture_root}/var/lib/sentrybox-deploy/restore-test.success"
  printf 'previous-validation\n' >"${marker}"
  chmod 0600 "${marker}"
  marker_before="$(stat -c '%i:%Y:%s' "${marker}"):$(sha256sum "${marker}" | cut -d' ' -f1)"
  export ERROR_HUB_FAKE_RESTORE_CLEANUP_FAIL=1

  run "${repository_root}/deploy/home-dev/restore-test.sh"

  [ "${status}" -ne 0 ]
  [[ "${output}" == *"container cleanup failed"* ]]
  [ "$(stat -c '%i:%Y:%s' "${marker}"):$(sha256sum "${marker}" | cut -d' ' -f1)" = \
    "${marker_before}" ]
  run find "${fixture_root}/var/lib/sentrybox-deploy" -maxdepth 1 \
    -type d -name 'restore-test.*' -print
  [ "${status}" -eq 0 ]
  [ -z "${output}" ]
}

@test "restore test leaves the existing success marker unchanged when temporary-tree cleanup fails" {
  write_runtime_state
  printf 'predeploy-good\n' \
    >"${fixture_root}/home/pbuchman/services/sentrybox/backups/predeploy.sqlite"
  marker="${fixture_root}/var/lib/sentrybox-deploy/restore-test.success"
  printf 'previous-validation\n' >"${marker}"
  chmod 0600 "${marker}"
  marker_before="$(stat -c '%i:%Y:%s' "${marker}"):$(sha256sum "${marker}" | cut -d' ' -f1)"
  export ERROR_HUB_FAKE_RESTORE_TREE_CLEANUP_FAIL=1

  run "${repository_root}/deploy/home-dev/restore-test.sh"

  [ "${status}" -ne 0 ]
  [[ "${output}" == *"temporary-tree cleanup failed"* ]]
  [ "$(stat -c '%i:%Y:%s' "${marker}"):$(sha256sum "${marker}" | cut -d' ' -f1)" = \
    "${marker_before}" ]
}

@test "restore test preserves the 15 GiB host reserve before copying the snapshot" {
  write_runtime_state
  printf 'predeploy-good\n' \
    >"${fixture_root}/home/pbuchman/services/sentrybox/backups/predeploy.sqlite"
  export ERROR_HUB_FAKE_AVAILABLE_KIB=$((15 * 1024 * 1024))

  run "${repository_root}/deploy/home-dev/restore-test.sh"

  [ "${status}" -ne 0 ]
  [[ "${output}" == *"15 GiB"* ]]
  run grep -F ' restore-test' "${ERROR_HUB_COMMAND_LOG}"
  [ "${status}" -ne 0 ]
}

@test "retained-finalize failure keeps the full backup and rolls the deployment back" {
  write_runtime_state
  printf 'live-database\n' \
    >"${fixture_root}/home/pbuchman/services/sentrybox/data/error-hub.sqlite"
  export ERROR_HUB_FAKE_RETAINED_FAIL=1

  run "${repository_root}/deploy/home-dev/deploy.sh"

  [ "${status}" -ne 0 ]
  [ "$(cat "${fixture_root}/home/pbuchman/services/sentrybox/backups/predeploy.sqlite")" = 'consistent-backup' ]
  run grep -F 'retained-finalize' "${ERROR_HUB_COMMAND_LOG}"
  [ "${status}" -eq 0 ]
  [ "$(cat "${fixture_root}/fake-state/compose-up-count")" -eq 2 ]
  run grep -F 'ERROR_HUB_DEPLOYED_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' \
    "${fixture_root}/var/lib/sentrybox-deploy/current.env"
  [ "${status}" -eq 0 ]
}

@test "first deployment finalize failure removes the uncommitted current state" {
  printf 'live-database\n' \
    >"${fixture_root}/home/pbuchman/services/sentrybox/data/error-hub.sqlite"
  export ERROR_HUB_FAKE_RETAINED_FAIL=1

  run "${repository_root}/deploy/home-dev/deploy.sh"

  [ "${status}" -ne 0 ]
  [ ! -e "${fixture_root}/var/lib/sentrybox-deploy/current.env" ]
  [ "$(cat "${fixture_root}/home/pbuchman/services/sentrybox/backups/predeploy.sqlite")" = 'consistent-backup' ]
}

@test "oversized backup is rejected without replacing the last known-good snapshot" {
  printf 'live-database\n' \
    >"${fixture_root}/home/pbuchman/services/sentrybox/data/error-hub.sqlite"
  printf 'last-known-good\n' \
    >"${fixture_root}/home/pbuchman/services/sentrybox/backups/predeploy.sqlite"
  export ERROR_HUB_FAKE_BACKUP_OVERSIZE=1

  run "${repository_root}/deploy/home-dev/backup.sh" predeploy \
    "ghcr.io/pbuchman/sentrybox@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

  [ "${status}" -ne 0 ]
  [[ "${output}" == *"5 GiB"* ]]
  [ "$(cat "${fixture_root}/home/pbuchman/services/sentrybox/backups/predeploy.sqlite")" = 'last-known-good' ]
  [ ! -e "${fixture_root}/home/pbuchman/services/sentrybox/backups/.predeploy.sqlite.tmp" ]
}

@test "backup failure aborts deployment before the new image starts and normal Caddy is restored" {
  write_runtime_state
  printf 'live-database\n' \
    >"${fixture_root}/home/pbuchman/services/sentrybox/data/error-hub.sqlite"
  export ERROR_HUB_FAKE_BACKUP_FAIL=1

  run "${repository_root}/deploy/home-dev/deploy.sh"

  [ "${status}" -ne 0 ]
  [ ! -e "${fixture_root}/fake-state/compose-up-count" ]
  run grep -F 'reverse_proxy 127.0.0.1:8140' \
    "${fixture_root}/etc/caddy/Caddyfile.d/sentrybox.caddy"
  [ "${status}" -eq 0 ]
  run grep -F 'systemctl reload caddy' "${ERROR_HUB_COMMAND_LOG}"
  [ "${status}" -eq 0 ]
  run grep -F "checkout --quiet --detach ${ERROR_HUB_FAKE_HEAD_SHA}" "${ERROR_HUB_COMMAND_LOG}"
  [ "${status}" -eq 0 ]
}

@test "migration probe requires the immediately previous runtime to read the upgraded copy" {
  write_runtime_state
  printf 'live-database\n' \
    >"${fixture_root}/home/pbuchman/services/sentrybox/data/error-hub.sqlite"
  export ERROR_HUB_FAKE_COMPAT_FAIL=1

  run "${repository_root}/deploy/home-dev/deploy.sh"

  [ "${status}" -ne 0 ]
  [ ! -e "${fixture_root}/fake-state/compose-up-count" ]
  run grep -F 'compatibility-new' "${ERROR_HUB_COMMAND_LOG}"
  [ "${status}" -eq 0 ]
  run grep -F 'compatibility-previous' "${ERROR_HUB_COMMAND_LOG}"
  [ "${status}" -eq 0 ]
  [ "$(grep -c -- '--network none.*--cap-drop ALL.*--security-opt no-new-privileges:true.*compatibility-' "${ERROR_HUB_COMMAND_LOG}")" -eq 2 ]
  run grep -E 'src=.*/var/lib/sentrybox-deploy/migration-probe\.[^,]+,dst=/probe' \
    "${ERROR_HUB_COMMAND_LOG}"
  [ "${status}" -eq 0 ]
  run grep -F "src=${fixture_root}/var/lib/sentrybox-deploy,dst=/probe" \
    "${ERROR_HUB_COMMAND_LOG}"
  [ "${status}" -ne 0 ]
  run find "${fixture_root}/var/lib/sentrybox-deploy" -maxdepth 1 \
    -type d -name 'migration-probe.*' -print
  [ "${status}" -eq 0 ]
  [ -z "${output}" ]
}

@test "successful deployment consumes one request and records only the immutable resolved digest" {
  run "${repository_root}/deploy/home-dev/deploy.sh"

  [ "${status}" -eq 0 ]
  [ ! -e "${fixture_root}/var/lib/sentrybox-deploy/deploy-request.json" ]
  run grep -F 'ERROR_HUB_IMAGE=ghcr.io/pbuchman/sentrybox@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' \
    "${fixture_root}/var/lib/sentrybox-deploy/current.env"
  [ "${status}" -eq 0 ]
  run grep -F 'compose --file' "${ERROR_HUB_COMMAND_LOG}"
  [ "${status}" -eq 0 ]
  [[ "${output}" == *"up -d --wait --remove-orphans"* ]]
}

@test "deployment proves public HTTPS OPTIONS and envelope POST after normal Caddy is restored" {
  run "${repository_root}/deploy/home-dev/deploy.sh"

  [ "${status}" -eq 0 ]
  normal_reload_line="$(grep -n '^systemctl reload caddy$' "${ERROR_HUB_COMMAND_LOG}" | sed -n '2p' | cut -d: -f1)"
  public_options_line="$(grep -n -F 'curl --fail --silent --show-error --connect-timeout 2 --max-time 10 --request OPTIONS' "${ERROR_HUB_COMMAND_LOG}" \
    | grep -F 'https://errors.intexuraos.cloud/api/1/envelope/' | cut -d: -f1)"
  public_post_line="$(grep -n -F 'curl --fail --silent --show-error --connect-timeout 2 --max-time 10 --request POST' "${ERROR_HUB_COMMAND_LOG}" \
    | grep -F 'https://errors.intexuraos.cloud/api/1/envelope/' | cut -d: -f1)"
  [ -n "${normal_reload_line}" ]
  [ -n "${public_options_line}" ]
  [ -n "${public_post_line}" ]
  [ "${normal_reload_line}" -lt "${public_options_line}" ]
  [ "${public_options_line}" -lt "${public_post_line}" ]
  [ "$(grep -c 'synthetic-prepare' "${ERROR_HUB_COMMAND_LOG}")" -eq 2 ]
  [ "$(grep -c 'synthetic-verify' "${ERROR_HUB_COMMAND_LOG}")" -eq 2 ]
  [ "$(grep -c 'synthetic-cleanup' "${ERROR_HUB_COMMAND_LOG}")" -eq 2 ]
}

@test "broken public HTTPS OPTIONS fails deployment after local ingest succeeds" {
  write_runtime_state
  export ERROR_HUB_FAKE_PUBLIC_OPTIONS_FAIL=1

  run "${repository_root}/deploy/home-dev/deploy.sh"

  [ "${status}" -ne 0 ]
  [ "$(cat "${fixture_root}/fake-state/compose-up-count")" -eq 2 ]
  run grep -F 'http://127.0.0.1:8140/api/1/envelope/' "${ERROR_HUB_COMMAND_LOG}"
  [ "${status}" -eq 0 ]
  run grep -F 'https://errors.intexuraos.cloud/api/1/envelope/' "${ERROR_HUB_COMMAND_LOG}"
  [ "${status}" -eq 0 ]
  run grep -F 'ERROR_HUB_IMAGE=ghcr.io/pbuchman/sentrybox@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' \
    "${fixture_root}/var/lib/sentrybox-deploy/current.env"
  [ "${status}" -eq 0 ]
}

@test "broken public HTTPS envelope POST fails deployment after local ingest succeeds" {
  write_runtime_state
  export ERROR_HUB_FAKE_PUBLIC_POST_FAIL=1

  run "${repository_root}/deploy/home-dev/deploy.sh"

  [ "${status}" -ne 0 ]
  [ "$(cat "${fixture_root}/fake-state/compose-up-count")" -eq 2 ]
  run grep -F 'http://127.0.0.1:8140/api/1/envelope/' "${ERROR_HUB_COMMAND_LOG}"
  [ "${status}" -eq 0 ]
  run grep -F -- '--request POST' "${ERROR_HUB_COMMAND_LOG}"
  [ "${status}" -eq 0 ]
  [[ "${output}" == *'https://errors.intexuraos.cloud/api/1/envelope/'* ]]
  run grep -F 'ERROR_HUB_IMAGE=ghcr.io/pbuchman/sentrybox@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' \
    "${fixture_root}/var/lib/sentrybox-deploy/current.env"
  [ "${status}" -eq 0 ]
}

@test "failed normal Caddy restore rolls back before committing the new deployment state" {
  write_runtime_state
  export ERROR_HUB_FAKE_CADDY_RESTORE_FAIL=1

  run "${repository_root}/deploy/home-dev/deploy.sh"

  [ "${status}" -ne 0 ]
  [ "$(cat "${fixture_root}/fake-state/compose-up-count")" -eq 2 ]
  run grep -F 'ERROR_HUB_IMAGE=ghcr.io/pbuchman/sentrybox@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' \
    "${fixture_root}/var/lib/sentrybox-deploy/current.env"
  [ "${status}" -eq 0 ]
  [ ! -e "${fixture_root}/var/lib/sentrybox-deploy/deploy-request.json" ]
}

@test "failed current state commit reconciles checkout before restoring the previous runtime" {
  write_runtime_state
  printf 'live-database\n' \
    >"${fixture_root}/home/pbuchman/services/sentrybox/data/error-hub.sqlite"
  export ERROR_HUB_FAKE_STATE_WRITE_FAIL=1

  run "${repository_root}/deploy/home-dev/deploy.sh"

  [ "${status}" -ne 0 ]
  [ "$(cat "${fixture_root}/fake-state/compose-up-count")" -eq 2 ]
  rollback_line="$(grep -n 'ERROR_HUB_IMAGE=ghcr.io/pbuchman/sentrybox@sha256:aaaaaaaa.*compose .* up -d --wait --remove-orphans' "${ERROR_HUB_COMMAND_LOG}" | tail -1 | cut -d: -f1)"
  checkout_line="$(grep -n "checkout --quiet --detach ${ERROR_HUB_FAKE_HEAD_SHA}" "${ERROR_HUB_COMMAND_LOG}" | tail -1 | cut -d: -f1)"
  [ -n "${rollback_line}" ]
  [ -n "${checkout_line}" ]
  [ "${checkout_line}" -lt "${rollback_line}" ]
  [ "$(grep -Fc \
    "git -c safe.directory=${fixture_root}/home/pbuchman/deploy/sentrybox -C ${fixture_root}/home/pbuchman/deploy/sentrybox checkout --quiet --detach ${ERROR_HUB_FAKE_HEAD_SHA}" \
    "${ERROR_HUB_COMMAND_LOG}")" -eq 1 ]
  [ "$(cat "${fixture_root}/fake-state/git-head")" = "${ERROR_HUB_FAKE_HEAD_SHA}" ]
  grep -Fx "ERROR_HUB_DEPLOYED_SHA=${ERROR_HUB_FAKE_HEAD_SHA}" \
    "${fixture_root}/var/lib/sentrybox-deploy/current.env"
  run find "${fixture_root}/var/lib/sentrybox-deploy" -name 'current.env.tmp.*' -print
  [ -z "${output}" ]
  [ "$(cat "${fixture_root}/home/pbuchman/services/sentrybox/backups/predeploy.sqlite")" = 'consistent-backup' ]
  run grep -F 'retained-finalize' "${ERROR_HUB_COMMAND_LOG}"
  [ "${status}" -eq 0 ]
}

@test "termination after runtime switch reconciles checkout before restoring the previous runtime" {
  write_runtime_state
  export ERROR_HUB_FAKE_READINESS_BLOCK=1

  run bash -c '
    "$1" & deploy_pid=$!
    for _ in $(seq 1 200); do
      [ -f "$2" ] && break
      sleep 0.01
    done
    [ -f "$2" ] || { kill -TERM "${deploy_pid}"; wait "${deploy_pid}"; exit 1; }
    kill -TERM "${deploy_pid}"
    wait "${deploy_pid}"
  ' _ "${repository_root}/deploy/home-dev/deploy.sh" \
    "${fixture_root}/fake-state/readiness-blocked"

  [ "${status}" -eq 143 ]
  [ "$(cat "${fixture_root}/fake-state/compose-up-count")" -eq 2 ]
  rollback_line="$(grep -n 'ERROR_HUB_IMAGE=ghcr.io/pbuchman/sentrybox@sha256:aaaaaaaa.*compose .* up -d --wait --remove-orphans' "${ERROR_HUB_COMMAND_LOG}" | tail -1 | cut -d: -f1)"
  checkout_line="$(grep -n "checkout --quiet --detach ${ERROR_HUB_FAKE_HEAD_SHA}" "${ERROR_HUB_COMMAND_LOG}" | tail -1 | cut -d: -f1)"
  [ -n "${rollback_line}" ]
  [ -n "${checkout_line}" ]
  [ "${checkout_line}" -lt "${rollback_line}" ]
  [ "$(grep -Fc \
    "git -c safe.directory=${fixture_root}/home/pbuchman/deploy/sentrybox -C ${fixture_root}/home/pbuchman/deploy/sentrybox checkout --quiet --detach ${ERROR_HUB_FAKE_HEAD_SHA}" \
    "${ERROR_HUB_COMMAND_LOG}")" -eq 1 ]
  [ "$(cat "${fixture_root}/fake-state/git-head")" = "${ERROR_HUB_FAKE_HEAD_SHA}" ]
  grep -Fx "ERROR_HUB_DEPLOYED_SHA=${ERROR_HUB_FAKE_HEAD_SHA}" \
    "${fixture_root}/var/lib/sentrybox-deploy/current.env"
}

@test "installed systemd units use fixed scripts, state, timers, and no webhook Docker access" {
  run "${repository_root}/deploy/home-dev/install.sh" \
    --private-origin "${ERROR_HUB_PRIVATE_ORIGIN}"
  [ "${status}" -eq 0 ]

  deploy_unit="${fixture_root}/etc/systemd/system/sentrybox-deploy.service"
  runtime_unit="${fixture_root}/etc/systemd/system/sentrybox.service"
  backup_timer="${fixture_root}/etc/systemd/system/sentrybox-backup.timer"
  monitor_timer="${fixture_root}/etc/systemd/system/sentrybox-monitor.timer"
  monitor_unit="${fixture_root}/etc/systemd/system/sentrybox-monitor.service"
  restore_timer="${fixture_root}/etc/systemd/system/sentrybox-restore-test.timer"
  restore_unit="${fixture_root}/etc/systemd/system/sentrybox-restore-test.service"
  run grep -F 'StateDirectory=sentrybox-deploy' "${deploy_unit}"
  [ "${status}" -eq 0 ]
  run grep -F 'ExecStart=/home/pbuchman/deploy/sentrybox/deploy/home-dev/deploy.sh' "${deploy_unit}"
  [ "${status}" -eq 0 ]
  run grep -F 'ExecStopPost=/usr/bin/install -m 0644 /home/pbuchman/deploy/sentrybox/deploy/home-dev/caddy-sentrybox.caddy /etc/caddy/Caddyfile.d/sentrybox.caddy' "${deploy_unit}"
  [ "${status}" -eq 0 ]
  run grep -F 'ExecStopPost=/usr/bin/caddy validate --config /etc/caddy/Caddyfile' "${deploy_unit}"
  [ "${status}" -eq 0 ]
  run grep -Fx 'Environment=XDG_CONFIG_HOME=/var/lib/sentrybox-deploy/caddy-validation/config' \
    "${deploy_unit}"
  [ "${status}" -eq 0 ]
  run grep -Fx 'Environment=XDG_DATA_HOME=/var/lib/sentrybox-deploy/caddy-validation/data' \
    "${deploy_unit}"
  [ "${status}" -eq 0 ]
  run grep -F 'ExecStopPost=/usr/bin/systemctl reload caddy' "${deploy_unit}"
  [ "${status}" -eq 0 ]
  run grep -F 'WorkingDirectory=/home/pbuchman/deploy/sentrybox' "${runtime_unit}"
  [ "${status}" -eq 0 ]
  run grep -Fx 'Environment=ERROR_HUB_RUNTIME_ENV_FILE=/var/lib/sentrybox-deploy/runtime.env' \
    "${runtime_unit}"
  [ "${status}" -eq 0 ]
  run grep -F 'Persistent=true' "${backup_timer}"
  [ "${status}" -eq 0 ]
  run grep -Fx 'ExecStart=/home/pbuchman/deploy/sentrybox/deploy/home-dev/monitor.sh' \
    "${monitor_unit}"
  [ "${status}" -eq 0 ]
  run grep -Fx 'StandardOutput=journal' "${monitor_unit}"
  [ "${status}" -eq 0 ]
  run grep -Fx 'StandardError=journal' "${monitor_unit}"
  [ "${status}" -eq 0 ]
  run grep -Fx 'StateDirectory=sentrybox-deploy' "${monitor_unit}"
  [ "${status}" -eq 0 ]
  run grep -Fx 'ReadWritePaths=/var/lib/sentrybox-deploy' "${monitor_unit}"
  [ "${status}" -eq 0 ]
  run grep -Fx 'NoNewPrivileges=true' "${monitor_unit}"
  [ "${status}" -eq 0 ]
  run grep -Fx 'CapabilityBoundingSet=' "${monitor_unit}"
  [ "${status}" -eq 0 ]
  run grep -Fx 'ProtectSystem=strict' "${monitor_unit}"
  [ "${status}" -eq 0 ]
  run grep -Fx 'ProtectHome=tmpfs' "${monitor_unit}"
  [ "${status}" -eq 0 ]
  run grep -Fx \
    'BindReadOnlyPaths=/home/pbuchman/deploy/sentrybox' "${monitor_unit}"
  [ "${status}" -eq 0 ]
  run grep -Fx 'PrivateTmp=true' "${monitor_unit}"
  [ "${status}" -eq 0 ]
  run grep -Fx 'TimeoutStartSec=30s' "${monitor_unit}"
  [ "${status}" -eq 0 ]
  run grep -Fx 'OnUnitActiveSec=5min' "${monitor_timer}"
  [ "${status}" -eq 0 ]
  run grep -Fx 'RandomizedDelaySec=30s' "${monitor_timer}"
  [ "${status}" -eq 0 ]
  run grep -Fx 'AccuracySec=30s' "${monitor_timer}"
  [ "${status}" -eq 0 ]
  run grep -Fx 'Persistent=true' "${monitor_timer}"
  [ "${status}" -ne 0 ]
  run grep -F 'Persistent=true' "${restore_timer}"
  [ "${status}" -eq 0 ]
  run grep -F 'ConditionFileIsExecutable=/home/pbuchman/deploy/sentrybox/deploy/home-dev/restore-test.sh' "${restore_unit}"
  [ "${status}" -eq 0 ]
  run grep -F 'ConditionPathIsExecutable=' "${restore_unit}"
  [ "${status}" -ne 0 ]
  run grep -R -E 'deploy-request\.json.*(docker\.sock|/data)|sentrybox-deploy-webhook.*docker\.sock' \
    "${fixture_root}/etc/systemd/system"
  [ "${status}" -ne 0 ]
  run grep -F 'sentrybox-monitor.timer' "${ERROR_HUB_COMMAND_LOG}"
  [ "${status}" -eq 0 ]
}

@test "deployment webhook runs Node jitless with only its checkout visible under home" {
  run "${repository_root}/deploy/home-dev/install.sh" \
    --private-origin "${ERROR_HUB_PRIVATE_ORIGIN}"
  [ "${status}" -eq 0 ]

  webhook_unit="${fixture_root}/etc/systemd/system/sentrybox-deploy-webhook.service"
  run grep -Fx \
    'ExecStart=/opt/nodejs/current/bin/node --jitless deploy/home-dev/deploy-webhook.mjs' \
    "${webhook_unit}"
  [ "${status}" -eq 0 ]
  run grep -Fx 'MemoryMax=128M' "${webhook_unit}"
  [ "${status}" -eq 0 ]
  run grep -Fx 'MemoryDenyWriteExecute=true' "${webhook_unit}"
  [ "${status}" -eq 0 ]
  run grep -Fx 'ProtectHome=tmpfs' "${webhook_unit}"
  [ "${status}" -eq 0 ]
  run grep -Fx \
    'BindReadOnlyPaths=/home/pbuchman/deploy/sentrybox' \
    "${webhook_unit}"
  [ "${status}" -eq 0 ]
  run grep -Fx \
    'SystemCallFilter=@system-service pkey_alloc pkey_free pkey_mprotect' \
    "${webhook_unit}"
  [ "${status}" -eq 0 ]
  run grep '^InaccessiblePaths=' "${webhook_unit}"
  [ "${status}" -eq 0 ]
  [ "${output}" = $'InaccessiblePaths=\nInaccessiblePaths=/var/run/docker.sock' ]
}

@test "first-release bootstrap is installed for one-time fixed-source activation" {
  run "${repository_root}/deploy/home-dev/install.sh" \
    --private-origin "${ERROR_HUB_PRIVATE_ORIGIN}"
  [ "${status}" -eq 0 ]

  bootstrap_unit="${fixture_root}/etc/systemd/system/sentrybox-deploy-bootstrap.service"
  grep -Fx \
    'ExecStart=/opt/nodejs/current/bin/node --jitless deploy/home-dev/bootstrap-release.mjs' \
    "${bootstrap_unit}"
  grep -Fx \
    'ConditionPathExists=/var/lib/sentrybox-deploy/bootstrap-github-token' \
    "${bootstrap_unit}"
  run grep -F 'LoadCredential=' "${bootstrap_unit}"
  [ "${status}" -ne 0 ]
  run grep -E 'systemctl (enable|start).*sentrybox-deploy-bootstrap' \
    "${ERROR_HUB_COMMAND_LOG}"
  [ "${status}" -ne 0 ]
}

@test "deploy installs the versioned maintenance fragment before runtime mutation" {
  maintenance_fragment="${fixture_root}/home/pbuchman/deploy/sentrybox/deploy/home-dev/caddy-sentrybox-maintenance.caddy"
  cat >"${maintenance_fragment}" <<'EOF'
errors.intexuraos.cloud:80 {
	handle {
		header Retry-After "121"
		respond "fixture maintenance route" 503
	}
}
EOF

  run "${repository_root}/deploy/home-dev/deploy.sh"

  [ "${status}" -eq 0 ]
  cmp "${maintenance_fragment}" \
    "${fixture_root}/fake-state/caddy-reload-1.caddy"
  cmp "${repository_root}/deploy/home-dev/caddy-sentrybox.caddy" \
    "${fixture_root}/fake-state/caddy-reload-2.caddy"
}

@test "maintenance window holds the deploy lock and restores normal routing after command failure" {
  cp "${repository_root}/deploy/home-dev/caddy-sentrybox.caddy" \
    "${fixture_root}/etc/caddy/Caddyfile.d/sentrybox.caddy"
  maintenance_fragment="${fixture_root}/home/pbuchman/deploy/sentrybox/deploy/home-dev/caddy-sentrybox-maintenance.caddy"
  cat >"${maintenance_fragment}" <<'EOF'
errors.intexuraos.cloud:80 {
	handle {
		header Retry-After "120"
		respond "temporarily unavailable" 503
	}
}
EOF
  probe="${fixture_root}/maintenance-probe.sh"
  cat >"${probe}" <<'EOF'
#!/bin/sh
grep -F 'header Retry-After "120"' \
  "${ERROR_HUB_TEST_ROOT}/etc/caddy/Caddyfile.d/sentrybox.caddy" >/dev/null
exec 8>"${ERROR_HUB_TEST_ROOT}/run/lock/sentrybox-deploy.lock"
if flock -n 8; then
  printf 'maintenance command did not inherit deploy lock protection\n' >&2
  exit 64
fi
exit 37
EOF
  chmod +x "${probe}"

  run "${repository_root}/deploy/home-dev/maintenance-window.sh" -- "${probe}"

  [ "${status}" -eq 37 ]
  cmp "${repository_root}/deploy/home-dev/caddy-sentrybox.caddy" \
    "${fixture_root}/etc/caddy/Caddyfile.d/sentrybox.caddy"
  [ "$(grep -c '^caddy validate ' "${ERROR_HUB_COMMAND_LOG}")" -eq 2 ]
  [ "$(grep -c '^systemctl reload caddy$' "${ERROR_HUB_COMMAND_LOG}")" -eq 2 ]
  maintenance_validate_line="$(grep -n '^caddy validate ' "${ERROR_HUB_COMMAND_LOG}" | sed -n '1p' | cut -d: -f1)"
  maintenance_reload_line="$(grep -n '^systemctl reload caddy$' "${ERROR_HUB_COMMAND_LOG}" | sed -n '1p' | cut -d: -f1)"
  normal_validate_line="$(grep -n '^caddy validate ' "${ERROR_HUB_COMMAND_LOG}" | sed -n '2p' | cut -d: -f1)"
  normal_reload_line="$(grep -n '^systemctl reload caddy$' "${ERROR_HUB_COMMAND_LOG}" | sed -n '2p' | cut -d: -f1)"
  [ "${maintenance_validate_line}" -lt "${maintenance_reload_line}" ]
  [ "${maintenance_reload_line}" -lt "${normal_validate_line}" ]
  [ "${normal_validate_line}" -lt "${normal_reload_line}" ]
}

@test "maintenance validation failure never reloads the invalid route and still restores normal routing" {
  cp "${repository_root}/deploy/home-dev/caddy-sentrybox.caddy" \
    "${fixture_root}/etc/caddy/Caddyfile.d/sentrybox.caddy"
  maintenance_fragment="${fixture_root}/home/pbuchman/deploy/sentrybox/deploy/home-dev/caddy-sentrybox-maintenance.caddy"
  cat >"${maintenance_fragment}" <<'EOF'
errors.intexuraos.cloud:80 {
	handle {
		header Retry-After "120"
		respond "temporarily unavailable" 503
	}
}
EOF
  export ERROR_HUB_FAKE_MAINTENANCE_VALIDATE_FAIL=1

  run "${repository_root}/deploy/home-dev/maintenance-window.sh" -- true

  [ "${status}" -ne 0 ]
  cmp "${repository_root}/deploy/home-dev/caddy-sentrybox.caddy" \
    "${fixture_root}/etc/caddy/Caddyfile.d/sentrybox.caddy"
  [ "$(grep -c '^caddy validate ' "${ERROR_HUB_COMMAND_LOG}")" -eq 2 ]
  [ "$(grep -c '^systemctl reload caddy$' "${ERROR_HUB_COMMAND_LOG}")" -eq 1 ]
  cmp "${repository_root}/deploy/home-dev/caddy-sentrybox.caddy" \
    "${fixture_root}/fake-state/caddy-reload-1.caddy"
}

@test "maintenance window rejects lock contention before changing the live route" {
  cp "${repository_root}/deploy/home-dev/caddy-sentrybox.caddy" \
    "${fixture_root}/etc/caddy/Caddyfile.d/sentrybox.caddy"
  maintenance_fragment="${fixture_root}/home/pbuchman/deploy/sentrybox/deploy/home-dev/caddy-sentrybox-maintenance.caddy"
  cp "${repository_root}/deploy/home-dev/caddy-sentrybox.caddy" \
    "${maintenance_fragment}"
  lock="${fixture_root}/run/lock/sentrybox-deploy.lock"
  exec 8>"${lock}"
  flock -n 8

  run "${repository_root}/deploy/home-dev/maintenance-window.sh" -- true

  [ "${status}" -ne 0 ]
  [[ "${output}" == *"already in progress"* ]]
  [ ! -e "${fixture_root}/fake-state/caddy-reload-1.caddy" ]
  cmp "${repository_root}/deploy/home-dev/caddy-sentrybox.caddy" \
    "${fixture_root}/etc/caddy/Caddyfile.d/sentrybox.caddy"
}

@test "maintenance window terminates a blocking command before restoring routing on TERM" {
  cp "${repository_root}/deploy/home-dev/caddy-sentrybox.caddy" \
    "${fixture_root}/etc/caddy/Caddyfile.d/sentrybox.caddy"
  blocker="${fixture_root}/maintenance-blocker.sh"
  cat >"${blocker}" <<'EOF'
#!/bin/sh
printf '%s\n' "$$" >"${ERROR_HUB_FAKE_STATE}/maintenance-child-pid"
trap 'exit 143' TERM
while :; do
  sleep 0.05
done
EOF
  chmod +x "${blocker}"

  run bash -c '
    wrapper="$1"
    blocker="$2"
    child_file="$3"
    "$wrapper" -- "$blocker" & wrapper_pid=$!
    for _ in $(seq 1 200); do
      [ -s "$child_file" ] && break
      sleep 0.01
    done
    [ -s "$child_file" ] || { kill -TERM "$wrapper_pid"; wait "$wrapper_pid"; exit 90; }
    child_pid="$(cat "$child_file")"
    kill -TERM "$wrapper_pid"
    for _ in $(seq 1 200); do
      kill -0 "$wrapper_pid" 2>/dev/null || break
      sleep 0.01
    done
    if kill -0 "$wrapper_pid" 2>/dev/null; then
      kill -TERM "$child_pid" 2>/dev/null || true
      wait "$wrapper_pid" 2>/dev/null || true
      exit 91
    fi
    wait "$wrapper_pid"
    wrapper_status=$?
    kill -0 "$child_pid" 2>/dev/null && exit 92
    exit "$wrapper_status"
  ' _ "${repository_root}/deploy/home-dev/maintenance-window.sh" \
    "${blocker}" "${fixture_root}/fake-state/maintenance-child-pid"

  [ "${status}" -eq 143 ]
  cmp "${repository_root}/deploy/home-dev/caddy-sentrybox.caddy" \
    "${fixture_root}/etc/caddy/Caddyfile.d/sentrybox.caddy"
  [ "$(grep -c '^systemctl reload caddy$' "${ERROR_HUB_COMMAND_LOG}")" -eq 2 ]
}

@test "maintenance window lets a command interrupted during stop finish service recovery" {
  cp "${repository_root}/deploy/home-dev/caddy-sentrybox.caddy" \
    "${fixture_root}/etc/caddy/Caddyfile.d/sentrybox.caddy"
  blocker="${fixture_root}/maintenance-delayed-recovery.sh"
  cat >"${blocker}" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$$" >"${ERROR_HUB_FAKE_STATE}/maintenance-child-pid"
service_recovery_required=0
recover_service() {
  exit_status=$?
  trap - EXIT
  if [ "${service_recovery_required}" -eq 1 ]; then
    : >"${ERROR_HUB_FAKE_STATE}/maintenance-recovery-started"
    sleep 5.5
    : >"${ERROR_HUB_FAKE_STATE}/maintenance-recovery-complete"
  fi
  exit "${exit_status}"
}
trap recover_service EXIT
service_recovery_required=1
: >"${ERROR_HUB_FAKE_STATE}/maintenance-stop-started"
sleep 300
EOF
  chmod +x "${blocker}"

  run bash -c '
    wrapper="$1"
    blocker="$2"
    child_file="$3"
    recovery_file="$4"
    stop_file="$5"
    recovery_started_file="$6"
    "$wrapper" -- "$blocker" & wrapper_pid=$!
    for _ in $(seq 1 200); do
      [ -s "$child_file" ] && [ -e "$stop_file" ] && break
      sleep 0.01
    done
    [ -s "$child_file" ] && [ -e "$stop_file" ] \
      || { kill -TERM "$wrapper_pid"; wait "$wrapper_pid"; exit 90; }
    child_pid="$(cat "$child_file")"
    kill -TERM "$wrapper_pid"
    for _ in $(seq 1 200); do
      [ -e "$recovery_started_file" ] && break
      sleep 0.01
    done
    [ -e "$recovery_started_file" ] \
      || { kill -KILL -- "-$child_pid" 2>/dev/null || true; wait "$wrapper_pid"; exit 94; }
    kill -TERM "$wrapper_pid"
    sleep 0.2
    kill -0 "$wrapper_pid" 2>/dev/null || exit 95
    grep -F "temporarily unavailable" \
      "${ERROR_HUB_TEST_ROOT}/etc/caddy/Caddyfile.d/sentrybox.caddy" >/dev/null \
      || exit 96
    for _ in $(seq 1 800); do
      kill -0 "$wrapper_pid" 2>/dev/null || break
      sleep 0.01
    done
    if kill -0 "$wrapper_pid" 2>/dev/null; then
      kill -KILL -- "-$child_pid" 2>/dev/null || true
      wait "$wrapper_pid" 2>/dev/null || true
      exit 91
    fi
    wait "$wrapper_pid"
    wrapper_status=$?
    [ -e "$recovery_file" ] || exit 92
    kill -0 "$child_pid" 2>/dev/null && exit 93
    exit "$wrapper_status"
  ' _ "${repository_root}/deploy/home-dev/maintenance-window.sh" \
    "${blocker}" "${fixture_root}/fake-state/maintenance-child-pid" \
    "${fixture_root}/fake-state/maintenance-recovery-complete" \
    "${fixture_root}/fake-state/maintenance-stop-started" \
    "${fixture_root}/fake-state/maintenance-recovery-started"

  [ "${status}" -eq 143 ]
  cmp "${repository_root}/deploy/home-dev/caddy-sentrybox.caddy" \
    "${fixture_root}/etc/caddy/Caddyfile.d/sentrybox.caddy"
  [ "$(grep -c '^systemctl reload caddy$' "${ERROR_HUB_COMMAND_LOG}")" -eq 2 ]
}

@test "maintenance window prioritizes a normal-route restoration failure" {
  cp "${repository_root}/deploy/home-dev/caddy-sentrybox.caddy" \
    "${fixture_root}/etc/caddy/Caddyfile.d/sentrybox.caddy"
  export ERROR_HUB_FAKE_CADDY_RESTORE_FAIL=1

  run "${repository_root}/deploy/home-dev/maintenance-window.sh" -- \
    sh -c 'exit 37'

  [ "${status}" -eq 70 ]
  [[ "${output}" == *"Normal Caddy routing could not be restored"* ]]
  [ "$(grep -c '^systemctl reload caddy$' "${ERROR_HUB_COMMAND_LOG}")" -eq 2 ]
}

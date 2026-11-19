#!/usr/bin/env bash
set -euo pipefail

script_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
readonly script_directory

if [[ "$(id -u)" -ne 0 ]]; then
  printf 'install.sh must run as root.\n' >&2
  exit 1
fi
if [[ "${ERROR_HUB_TEST_MODE:-}" != 1 ]]; then
  if [[ ! "${script_directory}" =~ ^/opt/sentrybox-control/releases/[0-9a-f]{40}/deploy/home-dev$ ]]; then
    printf 'Run install.sh from an exact reviewed release in /opt/sentrybox-control/releases.\n' >&2
    exit 1
  fi
  # Prove the source is protected before sourcing an additional script.
  directory="${script_directory}"
  while [[ "${directory}" != / ]]; do
    if [[ -L "${directory}" || "$(stat -c '%u:%g:%a' "${directory}")" != 0:0:755 ]]; then
      printf 'SentryBox release ancestors must be root-owned with mode 0755.\n' >&2
      exit 1
    fi
    directory="$(dirname "${directory}")"
  done
  unsafe_asset="$(find "${script_directory}" \
    \( ! -user root -o ! -group root -o -perm /022 -o \( ! -type f -a ! -type d \) \) \
    -print -quit)"
  if [[ -n "${unsafe_asset}" ]]; then
    printf 'SentryBox control assets must be protected regular files and directories.\n' >&2
    exit 1
  fi
fi
# shellcheck source=deploy/home-dev/common.sh
source "${script_directory}/common.sh"

for executable_asset in \
  backup.sh \
  monitor.sh \
  restore-test.sh; do
  if [[ ! -f "${script_directory}/${executable_asset}" \
    || -L "${script_directory}/${executable_asset}" \
    || ! -x "${script_directory}/${executable_asset}" ]]; then
    printf 'Required Home Dev executable is unavailable: %s\n' \
      "${script_directory}/${executable_asset}" >&2
    exit 1
  fi
done
for required_command in caddy chmod cp curl find flock mktemp sleep systemd-analyze systemd-sysusers; do
  error_hub_require_command "${required_command}"
done

error_hub_webhook_state() {
  local eh_unit="sentrybox-deploy-webhook.service"
  local eh_active_state eh_main_pid eh_restarts eh_sub_state

  eh_active_state="$(
    systemctl show "${eh_unit}" --property=ActiveState --value
  )" || return $?
  eh_sub_state="$(
    systemctl show "${eh_unit}" --property=SubState --value
  )" || return $?
  eh_main_pid="$(
    systemctl show "${eh_unit}" --property=MainPID --value
  )" || return $?
  eh_restarts="$(
    systemctl show "${eh_unit}" --property=NRestarts --value
  )" || return $?
  if [[ "${eh_active_state}" != "active" \
    || "${eh_sub_state}" != "running" \
    || ! "${eh_main_pid}" =~ ^[1-9][0-9]*$ \
    || ! "${eh_restarts}" =~ ^[0-9]+$ ]]; then
    return 1
  fi
  printf '%s\t%s\n' "${eh_main_pid}" "${eh_restarts}"
}

error_hub_probe_webhook() {
  curl --silent --show-error --connect-timeout 1 --max-time 2 \
    --request POST \
    --header 'content-type: application/json' \
    --data '{}' \
    --output /dev/null \
    --write-out $'%{http_code}\n%header{x-sentrybox-deploy-handler}' \
    http://127.0.0.1:9003/github/workflow-run
}

error_hub_verify_webhook_stability() {
  local eh_attempt eh_curl_status eh_probe eh_state
  local eh_ready=0
  local -r eh_expected_probe=$'400\nworkflow-run-v1'
  local -r eh_readiness_attempts=10
  local -r eh_readiness_wait_seconds=0.1
  local -r eh_stability_attempts=7

  eh_state="$(error_hub_webhook_state)" || return $?
  for ((eh_attempt = 1; \
    eh_attempt <= eh_readiness_attempts; \
    eh_attempt++)); do
    [[ "$(error_hub_webhook_state)" == "${eh_state}" ]] || return 1
    eh_probe=""
    if eh_probe="$(error_hub_probe_webhook)"; then
      eh_curl_status=0
    else
      eh_curl_status=$?
    fi
    [[ "$(error_hub_webhook_state)" == "${eh_state}" ]] || return 1
    if (( eh_curl_status == 0 )); then
      [[ "${eh_probe}" == "${eh_expected_probe}" ]] || return 1
      eh_ready=1
      break
    fi
    (( eh_curl_status == 7 )) || return "${eh_curl_status}"
    if (( eh_attempt < eh_readiness_attempts )); then
      sleep "${eh_readiness_wait_seconds}" || return $?
    fi
  done
  (( eh_ready == 1 )) || return 1

  for ((eh_attempt = 1; \
    eh_attempt <= eh_stability_attempts; \
    eh_attempt++)); do
    [[ "$(error_hub_webhook_state)" == "${eh_state}" ]] || return 1
    eh_probe="$(error_hub_probe_webhook)" || return $?
    [[ "${eh_probe}" == "${eh_expected_probe}" ]] || return 1
    [[ "$(error_hub_webhook_state)" == "${eh_state}" ]] || return 1
    if (( eh_attempt < eh_stability_attempts )); then
      sleep 1 || return $?
    fi
  done
}

private_origin=""
migrate=0
start_webhook=0
while (( $# > 0 )); do
  case "$1" in
    --private-origin)
      [[ $# -ge 2 ]] || {
        printf '%s requires a value.\n' "$1" >&2
        exit 2
      }
      private_origin="$2"
      shift 2
      ;;
    --migrate)
      migrate=1
      shift
      ;;
    --start-webhook)
      start_webhook=1
      shift
      ;;
    *)
      printf 'Unknown installation argument: %s\n' "$1" >&2
      exit 2
      ;;
  esac
done
error_hub_require_private_origin "${private_origin}"

error_hub_require_system_node

runtime_uid="${ERROR_HUB_RUNTIME_UID:-$(id -u pbuchman)}"
runtime_gid="${ERROR_HUB_RUNTIME_GID:-$(id -g pbuchman)}"
readonly runtime_uid runtime_gid
if [[ ! "${runtime_uid}" =~ ^[1-9][0-9]*$ || ! "${runtime_gid}" =~ ^[1-9][0-9]*$ ]]; then
  printf 'Runtime UID and GID must be numeric and non-root.\n' >&2
  exit 1
fi

readonly legacy_root="${error_hub_prefix}/home/pbuchman/services/sentrybox"
readonly protected_files="${script_directory}/protected-files.py"
readonly webhook_state="${error_hub_prefix}/var/lib/sentrybox-deploy-webhook"
readonly tunnel_token="${error_hub_deploy_credentials_directory}/cloudflare-tunnel-token"
readonly legacy_tunnel_token="${legacy_root}/deploy/cloudflare-tunnel-token"
readonly tunnel_migration="${error_hub_state_directory}/tunnel-token-migration"
webhook_was_active="${start_webhook}"
if systemctl is-active --quiet sentrybox-deploy-webhook.service; then
  webhook_was_active=1
fi

if [[ -z "${error_hub_prefix}" ]]; then
  for directory in /etc /etc/caddy /etc/systemd /etc/systemd/system /var /var/lib; do
    if [[ -L "${directory}" || "$(stat -c '%a:%u:%g:%F' "${directory}")" != '755:0:0:directory' ]]; then
      printf 'SentryBox host ancestor must be a protected directory: %s\n' "${directory}" >&2
      exit 1
    fi
  done
fi

for directory in "${error_hub_service_root}" "${error_hub_deploy_credentials_directory}" \
  "${error_hub_state_directory}"; do
  if [[ -e "${directory}" || -L "${directory}" ]]; then
    error_hub_require_root_private_directory "${directory}" "SentryBox deployment state or private directory"
  else
    install -d -o 0 -g 0 -m 0700 "${directory}"
  fi
done
umask 077
exec 8>"${error_hub_state_directory}/install.lock"
flock -n 8
exec 9>"${error_hub_lock_file}"
flock -n 9

if (( migrate == 1 )); then
  for unit in sentrybox.service sentrybox-deploy.service sentrybox-deploy-bootstrap.service \
    sentrybox-deploy-webhook.service sentrybox-backup.service sentrybox-monitor.service \
    sentrybox-restore-test.service sentrybox-backup.timer sentrybox-monitor.timer \
    sentrybox-restore-test.timer; do
    state="$(systemctl show "${unit}" --property=ActiveState --value)"
    if [[ "${state}" != inactive && "${state}" != failed ]]; then
      printf 'Quiesce %s before migrating SentryBox paths.\n' "${unit}" >&2
      exit 1
    fi
  done
  for unit in sentrybox.service sentrybox-deploy-webhook.service \
    sentrybox-backup.timer sentrybox-monitor.timer sentrybox-restore-test.timer; do
    if systemctl is-enabled --quiet "${unit}"; then
      printf 'Disable legacy autostart for %s before migration.\n' "${unit}" >&2
      exit 1
    fi
  done
  running_containers="$(docker ps --quiet --filter label=com.docker.compose.project=sentrybox \
    --filter label=com.docker.compose.service=sentrybox)"
  if [[ -n "${running_containers}" ]]; then
    printf 'Stop the legacy SentryBox container before migrating its data directory.\n' >&2
    exit 1
  fi
  for name in env data backups deploy/github-webhook-secret; do
    source_path="${legacy_root}/${name}"
    destination_path="${error_hub_service_root}/${name}"
    owner=("${runtime_uid}" "${runtime_gid}")
    action=move-file
    case "${name}" in
      data|backups) action=move-directory ;;
      deploy/*)
        destination_path="${error_hub_deploy_credentials_directory}/${name##*/}"
        owner=(0 0)
        ;;
    esac
    if [[ -e "${source_path}" || -L "${source_path}" ]]; then
      if [[ -e "${destination_path}" || -L "${destination_path}" ]]; then
        printf 'Both legacy and protected entries exist for %s.\n' "${name}" >&2
        exit 1
      fi
      /usr/bin/python3 -I "${protected_files}" "${action}" \
        "${source_path}" "${destination_path}" "${owner[@]}"
    fi
  done
  if [[ -e "${legacy_tunnel_token}" || -L "${legacy_tunnel_token}" ]]; then
    /usr/bin/python3 -I "${protected_files}" stage-credential \
      "${legacy_tunnel_token}" "${tunnel_token}" 0 0
    printf 'pending\n' >"${tunnel_migration}"
    sync -f "${tunnel_migration}"
  fi
elif [[ -z "${error_hub_prefix}" && ! -L "${error_hub_control_root}/current" \
    && ( -e "${legacy_root}/env" || -L "${legacy_root}/env" ) ]]; then
  printf 'Use the documented SentryBox migration procedure for the legacy installation.\n' >&2
  exit 1
fi

if (( migrate == 1 )) && [[ -d "${error_hub_backup_directory}" \
  && ! -L "${error_hub_backup_directory}" \
  && "$(stat -c '%a:%u:%g' "${error_hub_backup_directory}")" == "700:${runtime_uid}:${runtime_gid}" ]]; then
  chown -h 0:0 "${error_hub_backup_directory}"
fi

for directory in "${error_hub_data_directory}" "${error_hub_backup_directory}"; do
  owner=("${runtime_uid}" "${runtime_gid}")
  if [[ "${directory}" == "${error_hub_backup_directory}" ]]; then
    owner=(0 0)
  fi
  if [[ ! -e "${directory}" && ! -L "${directory}" ]]; then
    install -d -o "${owner[0]}" -g "${owner[1]}" -m 0700 "${directory}"
  elif [[ ! -d "${directory}" || -L "${directory}" \
    || "$(stat -c '%a:%u:%g' "${directory}")" != "700:${owner[0]}:${owner[1]}" ]]; then
    printf 'SentryBox directory metadata is invalid: %s\n' "${directory}" >&2
    exit 1
  fi
done
if [[ -f "${error_hub_backup_directory}/predeploy.sqlite" \
  && "$(stat -c '%u:%g' "${error_hub_backup_directory}/predeploy.sqlite")" == "${runtime_uid}:${runtime_gid}" ]]; then
  /usr/bin/python3 -I "${protected_files}" seal-backup \
    "${error_hub_backup_directory}/predeploy.sqlite" \
    "${error_hub_backup_directory}/predeploy.sqlite" "${runtime_uid}" "${runtime_gid}"
fi
error_hub_require_service_credentials
if (( webhook_was_active == 1 )); then
  error_hub_require_root_private_file "${error_hub_webhook_credential}" \
    "SentryBox deployment webhook credential"
fi
if [[ -e "${tunnel_token}" || -L "${tunnel_token}" ]]; then
  error_hub_require_root_private_file "${tunnel_token}" "SentryBox tunnel credential"
fi

if [[ -e "${error_hub_runtime_environment_file}" || -L "${error_hub_runtime_environment_file}" ]]; then
  if [[ ! -f "${error_hub_runtime_environment_file}" \
    || -L "${error_hub_runtime_environment_file}" \
    || "$(stat -c '%h' "${error_hub_runtime_environment_file}")" != "1" ]]; then
    printf 'SentryBox runtime environment must be a regular, singly linked file.\n' >&2
    exit 1
  fi
  error_hub_require_root_private_file "${error_hub_runtime_environment_file}" "SentryBox runtime environment"
else
  runtime_environment_temporary="${error_hub_runtime_environment_file}.tmp.$$"
  umask 077
  printf 'ERROR_HUB_REQUIRED_SECRET_REFERENCES=%s\n' \
    "${error_hub_required_secret_references}" >"${runtime_environment_temporary}"
  chown 0:0 "${runtime_environment_temporary}"
  chmod 0600 "${runtime_environment_temporary}"
  mv -f "${runtime_environment_temporary}" "${error_hub_runtime_environment_file}"
fi
error_hub_require_runtime_environment
if [[ -z "${error_hub_prefix}" ]]; then
  systemd-sysusers "${script_directory}/sentrybox-webhook.sysusers.conf"
  webhook_uid="$(id -u sentrybox-webhook)"
  webhook_gid="$(id -g sentrybox-webhook)"
  if [[ ! "${webhook_uid}" =~ ^[1-9][0-9]*$ || ! "${webhook_gid}" =~ ^[1-9][0-9]*$ ]] \
    || [[ "$(id -G sentrybox-webhook)" != "${webhook_gid}" || -L "${webhook_state}" ]]; then
    printf 'SentryBox webhook account or state path is unsafe.\n' >&2
    exit 1
  fi
  if [[ -e "${webhook_state}" ]]; then
    [[ -d "${webhook_state}" && "$(stat -c '%a:%u:%g' "${webhook_state}")" == "700:${webhook_uid}:${webhook_gid}" ]]
  else
    install -d -o "${webhook_uid}" -g "${webhook_gid}" -m 0700 "${webhook_state}"
  fi
  legacy_deliveries="${error_hub_state_directory}/deliveries.json"
  if [[ -e "${legacy_deliveries}" && ! -e "${webhook_state}/deliveries.json" \
    && ! -L "${webhook_state}/deliveries.json" ]]; then
    error_hub_require_root_private_file "${legacy_deliveries}" "SentryBox delivery history"
    # shellcheck disable=SC2016 # The dedicated account expands its argument.
    runuser -u sentrybox-webhook -- /usr/bin/bash --noprofile --norc -c \
      'set -o noclobber; umask 077; cat > "$1"' _ "${webhook_state}/deliveries.json" <"${legacy_deliveries}"
  fi
fi

readonly systemd_directory="${error_hub_prefix}/etc/systemd/system"
install -d -m 0755 "${systemd_directory}"
install -d -m 0755 "${error_hub_caddy_directory}"
install_staging="$(
  mktemp -d "${error_hub_state_directory}/install-assets.XXXXXX"
)"
readonly install_staging
case "${install_staging}" in
  "${error_hub_state_directory}/install-assets."*) ;;
  *)
    printf 'Install staging directory is outside deployment state.\n' >&2
    exit 1
    ;;
esac
cleanup_install_staging() {
  local exit_status=$?
  trap - EXIT
  if ! rm -rf -- "${install_staging}" \
    || [[ -e "${install_staging}" || -L "${install_staging}" ]]; then
    printf 'Install staging cleanup failed: %s\n' "${install_staging}" >&2
    if (( exit_status == 0 )); then
      exit_status=1
    fi
  fi
  exit "${exit_status}"
}
trap cleanup_install_staging EXIT
install -d -m 0700 \
  "${install_staging}/caddy/Caddyfile.d" \
  "${install_staging}/caddy-config" \
  "${install_staging}/caddy-data" \
  "${install_staging}/units"
install -m 0644 "${error_hub_caddy_config}" \
  "${install_staging}/caddy/Caddyfile"
cp -a "${error_hub_caddy_directory}/." \
  "${install_staging}/caddy/Caddyfile.d/"
install -m 0644 "${script_directory}/caddy-sentrybox.caddy" \
  "${install_staging}/caddy/Caddyfile.d/sentrybox.caddy"
install -m 0644 "${script_directory}/caddy-sentrybox-deploy.caddy" \
  "${install_staging}/caddy/Caddyfile.d/sentrybox-deploy.caddy"
units=(
  sentrybox.service
  sentrybox-deploy.service
  sentrybox-deploy-webhook.service
  sentrybox-deploy-request.socket
  sentrybox-deploy-request@.service
  sentrybox-deploy-bootstrap.service
  sentrybox-backup.service
  sentrybox-backup.timer
  sentrybox-monitor.service
  sentrybox-monitor.timer
  sentrybox-restore-test.service
  sentrybox-restore-test.timer
)
if [[ -e "${tunnel_token}" && -f "${systemd_directory}/cloudflared.service" ]]; then
  units+=(cloudflared.service)
fi
staged_units=()
for unit in "${units[@]}"; do
  install -m 0644 "${script_directory}/${unit}" "${install_staging}/units/${unit}"
  staged_units+=("${install_staging}/units/${unit}")
done

(
  cd "${install_staging}/caddy"
  XDG_CONFIG_HOME="${install_staging}/caddy-config" \
    XDG_DATA_HOME="${install_staging}/caddy-data" \
    caddy validate --config Caddyfile --adapter caddyfile
)
if [[ -z "${error_hub_prefix}" ]]; then
  # Verify against the candidate executable paths before rotating the selector.
  for unit in "${staged_units[@]}"; do
    sed -i "s|/opt/sentrybox-control/current/deploy/home-dev|${script_directory}|g" "${unit}"
  done
fi
systemd-analyze verify "${staged_units[@]}"

private_origin_file="${error_hub_state_directory}/private-origin"
private_origin_temporary="$(mktemp "${private_origin_file}.tmp.XXXXXX")"
printf '%s\n' "${private_origin}" >"${private_origin_temporary}"
error_hub_publish_root_private_file \
  "${private_origin_temporary}" "${private_origin_file}" \
  "SentryBox private origin"


publish_asset() {
  local source="$1" destination="$2" temporary
  temporary="$(mktemp "${destination}.XXXXXX")"
  if ! install -m 0644 "${source}" "${temporary}" || ! mv -fT "${temporary}" "${destination}"; then
    rm -f -- "${temporary}"
    return 1
  fi
}
if [[ -z "${error_hub_prefix}" ]]; then
  selector_directory="$(mktemp -d "${error_hub_control_root}/selector.XXXXXX")"
  release_directory="${script_directory%/deploy/home-dev}"
  ln -s "releases/${release_directory##*/}" "${selector_directory}/current"
  mv -fT "${selector_directory}/current" "${error_hub_control_root}/current"
  rmdir "${selector_directory}"
fi
publish_asset "${install_staging}/caddy/Caddyfile.d/sentrybox.caddy" "${error_hub_caddy_fragment}"
publish_asset "${install_staging}/caddy/Caddyfile.d/sentrybox-deploy.caddy" "${error_hub_caddy_deploy_fragment}"
for unit in "${units[@]}"; do
  publish_asset "${script_directory}/${unit}" "${systemd_directory}/${unit}"
done

systemctl daemon-reload
# Jobs that start after this point use only the protected control and paths.
flock -u 9
if (( webhook_was_active == 1 )); then
  systemctl start sentrybox-deploy-request.socket
  systemctl enable sentrybox-deploy-webhook.service >/dev/null
  if ! systemctl restart sentrybox-deploy-webhook.service; then
    printf 'Previously active SentryBox deployment webhook failed to restart.\n' >&2
    exit 1
  fi
  if ! systemctl is-active --quiet sentrybox-deploy-webhook.service; then
    printf 'Restarted SentryBox deployment webhook is not active.\n' >&2
    exit 1
  fi
  if ! error_hub_verify_webhook_stability; then
    printf 'Restarted SentryBox deployment webhook did not remain stable.\n' >&2
    exit 1
  fi
fi
systemctl enable --now \
  sentrybox.service \
  sentrybox-backup.timer \
  sentrybox-monitor.timer \
  sentrybox-restore-test.timer >/dev/null
# The monitor oneshot has TimeoutStartSec=30s. Keep a small bounded margin so an
# immediate OnBootSec activation can finish before its next schedule is checked.
readonly timer_schedule_attempts=36
readonly timer_schedule_wait_seconds=1
for timer in \
  sentrybox-backup.timer \
  sentrybox-monitor.timer \
  sentrybox-restore-test.timer; do
  if ! systemctl is-active --quiet "${timer}"; then
    printf 'SentryBox operational timer is not active: %s\n' "${timer}" >&2
    exit 1
  fi
  timer_schedule_ready=0
  for ((timer_schedule_attempt = 1; \
    timer_schedule_attempt <= timer_schedule_attempts; \
    timer_schedule_attempt++)); do
    timer_schedule="$(
      systemctl list-timers --all --no-legend --no-pager "${timer}"
    )"
    if [[ -n "${timer_schedule}" \
      && "${timer_schedule}" =~ [[:space:]]${timer}[[:space:]] \
      && ! "${timer_schedule}" =~ ^[[:space:]]*(n/a|-)($|[[:space:]]) ]]; then
      timer_schedule_ready=1
      break
    fi
    if (( timer_schedule_attempt < timer_schedule_attempts )); then
      sleep "${timer_schedule_wait_seconds}"
    fi
  done
  if (( timer_schedule_ready == 0 )); then
    printf 'SentryBox operational timer has no next activation: %s\n' \
      "${timer}" >&2
    exit 1
  fi
done

error_hub_validate_caddy >/dev/null
systemctl reload caddy
if [[ -e "${tunnel_migration}" ]]; then
  error_hub_require_root_private_file "${tunnel_migration}" "SentryBox tunnel migration marker"
  if [[ -e "${legacy_tunnel_token}" || -L "${legacy_tunnel_token}" ]]; then
    /usr/bin/python3 -I "${protected_files}" retire-credential \
      "${legacy_tunnel_token}" "${tunnel_token}" 0 0
  fi
  rm -- "${tunnel_migration}"
fi

printf 'SentryBox Home Dev service assets installed.\n'

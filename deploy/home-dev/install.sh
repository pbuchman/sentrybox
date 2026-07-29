#!/usr/bin/env bash
set -euo pipefail

script_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly script_directory
repository_root="$(cd "${script_directory}/../.." && pwd)"
readonly repository_root
# shellcheck source=deploy/home-dev/common.sh
source "${script_directory}/common.sh"

for executable_asset in backup.sh monitor.sh restore-test.sh; do
  if [[ ! -f "${script_directory}/${executable_asset}" \
    || -L "${script_directory}/${executable_asset}" \
    || ! -x "${script_directory}/${executable_asset}" ]]; then
    printf 'Required Home Dev executable is unavailable: %s\n' \
      "${script_directory}/${executable_asset}" >&2
    exit 1
  fi
done
for required_command in caddy cp mktemp systemd-analyze; do
  error_hub_require_command "${required_command}"
done

private_origin=""
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
    *)
      printf 'Unknown installation argument: %s\n' "$1" >&2
      exit 2
      ;;
  esac
done
error_hub_require_private_origin "${private_origin}"

if [[ -z "${error_hub_prefix}" && "${repository_root}" != "${error_hub_checkout}" ]]; then
  printf 'Run install.sh from the canonical checkout at %s.\n' "${error_hub_checkout}" >&2
  exit 1
fi
if [[ "$(id -u)" -ne 0 ]]; then
  printf 'install.sh must run as root.\n' >&2
  exit 1
fi

runtime_uid="${ERROR_HUB_RUNTIME_UID:-$(id -u pbuchman)}"
runtime_gid="${ERROR_HUB_RUNTIME_GID:-$(id -g pbuchman)}"
readonly runtime_uid runtime_gid
if [[ ! "${runtime_uid}" =~ ^[1-9][0-9]*$ || ! "${runtime_gid}" =~ ^[1-9][0-9]*$ ]]; then
  printf 'Runtime UID and GID must be numeric and non-root.\n' >&2
  exit 1
fi

install -d -m 0755 "${error_hub_checkout}"
install -d -m 0700 "${error_hub_service_root}"
if [[ ! -e "${error_hub_environment_file}" ]]; then
  install -m 0600 /dev/null "${error_hub_environment_file}"
else
  chmod 0600 "${error_hub_environment_file}"
fi
install -d -m 0700 "${error_hub_data_directory}"
install -d -m 0700 "${error_hub_backup_directory}"
chown "${runtime_uid}:${runtime_gid}" \
  "${error_hub_service_root}" \
  "${error_hub_environment_file}" \
  "${error_hub_data_directory}" \
  "${error_hub_backup_directory}"
install -d -o 0 -g 0 -m 0700 "${error_hub_deploy_credentials_directory}"

install -d -m 0700 "${error_hub_state_directory}"
if [[ -e "${error_hub_runtime_environment_file}" || -L "${error_hub_runtime_environment_file}" ]]; then
  if [[ ! -f "${error_hub_runtime_environment_file}" || -L "${error_hub_runtime_environment_file}" ]]; then
    printf 'SentryBox runtime environment must be a regular file.\n' >&2
    exit 1
  fi
  chown 0:0 "${error_hub_runtime_environment_file}"
  chmod 0600 "${error_hub_runtime_environment_file}"
else
  runtime_environment_temporary="${error_hub_runtime_environment_file}.tmp.$$"
  umask 077
  printf 'ERROR_HUB_REQUIRED_SECRET_REFERENCES=%s\n' \
    "${error_hub_initial_secret_references}" >"${runtime_environment_temporary}"
  chown 0:0 "${runtime_environment_temporary}"
  chmod 0600 "${runtime_environment_temporary}"
  mv -f "${runtime_environment_temporary}" "${error_hub_runtime_environment_file}"
fi
error_hub_require_runtime_environment
private_origin_file="${error_hub_state_directory}/private-origin"
printf '%s\n' "${private_origin}" >"${private_origin_file}.tmp.$$"
chmod 0600 "${private_origin_file}.tmp.$$"
mv -f "${private_origin_file}.tmp.$$" "${private_origin_file}"

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
for unit in \
  sentrybox.service \
  sentrybox-deploy.service \
  sentrybox-deploy-webhook.service \
  sentrybox-backup.service \
  sentrybox-backup.timer \
  sentrybox-restore-test.service \
  sentrybox-restore-test.timer; do
  install -m 0644 "${script_directory}/${unit}" \
    "${install_staging}/units/${unit}"
done

systemd-analyze verify \
  "${install_staging}/units/sentrybox.service" \
  "${install_staging}/units/sentrybox-deploy.service" \
  "${install_staging}/units/sentrybox-deploy-webhook.service" \
  "${install_staging}/units/sentrybox-backup.service" \
  "${install_staging}/units/sentrybox-backup.timer" \
  "${install_staging}/units/sentrybox-restore-test.service" \
  "${install_staging}/units/sentrybox-restore-test.timer"
(
  cd "${install_staging}/caddy"
  XDG_CONFIG_HOME="${install_staging}/caddy-config" \
    XDG_DATA_HOME="${install_staging}/caddy-data" \
    caddy validate --config Caddyfile --adapter caddyfile
)

install -m 0644 \
  "${install_staging}/caddy/Caddyfile.d/sentrybox.caddy" \
  "${error_hub_caddy_fragment}"
install -m 0644 \
  "${install_staging}/caddy/Caddyfile.d/sentrybox-deploy.caddy" \
  "${error_hub_caddy_deploy_fragment}"
for unit in \
  sentrybox.service \
  sentrybox-deploy.service \
  sentrybox-deploy-webhook.service \
  sentrybox-backup.service \
  sentrybox-backup.timer \
  sentrybox-restore-test.service \
  sentrybox-restore-test.timer; do
  install -m 0644 "${install_staging}/units/${unit}" \
    "${systemd_directory}/${unit}"
done

systemctl daemon-reload
systemctl enable \
  sentrybox.service \
  sentrybox-backup.timer \
  sentrybox-restore-test.timer >/dev/null

error_hub_validate_caddy >/dev/null
systemctl reload caddy

printf 'SentryBox Home Dev service assets installed.\n'

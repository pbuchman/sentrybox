#!/usr/bin/env bash
# shellcheck disable=SC2034 # This file exposes constants and state to sourcing scripts.

if [[ -n "${ERROR_HUB_TEST_ROOT:-}" ]]; then
  if [[ "${ERROR_HUB_TEST_MODE:-}" != "1" \
    || "${ERROR_HUB_TEST_ROOT}" != /tmp/* \
    || "${ERROR_HUB_TEST_ROOT}" == *".."* \
    || ! -d "${ERROR_HUB_TEST_ROOT}" ]]; then
    printf 'ERROR_HUB_TEST_ROOT is allowed only for an explicit disposable test root.\n' >&2
    exit 1
  fi
  readonly error_hub_prefix="${ERROR_HUB_TEST_ROOT}"
else
  readonly error_hub_prefix=""
fi

readonly error_hub_checkout="${error_hub_prefix}/home/pbuchman/deploy/sentrybox"
readonly error_hub_service_root="${error_hub_prefix}/home/pbuchman/services/sentrybox"
readonly error_hub_deploy_credentials_directory="${error_hub_service_root}/deploy"
readonly error_hub_environment_file="${error_hub_service_root}/env"
readonly error_hub_data_directory="${error_hub_service_root}/data"
readonly error_hub_database="${error_hub_data_directory}/error-hub.sqlite"
readonly error_hub_backup_directory="${error_hub_prefix}/home/pbuchman/services/sentrybox/backups"
readonly error_hub_state_directory="${error_hub_prefix}/var/lib/sentrybox-deploy"
readonly error_hub_runtime_environment_file="${error_hub_state_directory}/runtime.env"
readonly error_hub_required_secret_references="CODE_AGENT_HMAC_DEV,CODE_AGENT_HMAC_PROD"
readonly error_hub_lock_file="${error_hub_prefix}/run/lock/sentrybox-deploy.lock"
readonly error_hub_request_file="${error_hub_state_directory}/deploy-request.json"
readonly error_hub_current_state="${error_hub_state_directory}/current.env"
readonly error_hub_previous_state="${error_hub_state_directory}/previous.env"
readonly error_hub_backup_state_file="${error_hub_state_directory}/backup.state"
readonly error_hub_backup_success_file="${error_hub_state_directory}/backup.success"
readonly error_hub_restore_success_file="${error_hub_state_directory}/restore-test.success"
readonly error_hub_monitor_baseline_file="${error_hub_state_directory}/monitor-baseline"
readonly error_hub_compose_file="${error_hub_checkout}/deploy/home-dev/compose.yaml"
readonly error_hub_project_config="${error_hub_checkout}/deploy/home-dev/config.example.json"
readonly error_hub_database_operations="${error_hub_checkout}/deploy/home-dev/database-operations.mjs"
readonly error_hub_caddy_directory="${error_hub_prefix}/etc/caddy/Caddyfile.d"
readonly error_hub_caddy_fragment="${error_hub_caddy_directory}/sentrybox.caddy"
readonly error_hub_caddy_deploy_fragment="${error_hub_caddy_directory}/sentrybox-deploy.caddy"
readonly error_hub_caddy_normal_source="${error_hub_checkout}/deploy/home-dev/caddy-sentrybox.caddy"
readonly error_hub_caddy_maintenance_source="${error_hub_checkout}/deploy/home-dev/caddy-sentrybox-maintenance.caddy"
readonly error_hub_caddy_config="${error_hub_prefix}/etc/caddy/Caddyfile"
readonly error_hub_caddy_validation_root="${error_hub_state_directory}/caddy-validation"
readonly error_hub_caddy_validation_config="${error_hub_caddy_validation_root}/config"
readonly error_hub_caddy_validation_data="${error_hub_caddy_validation_root}/data"
readonly error_hub_repository="pbuchman/sentrybox"
readonly error_hub_workflow="Release SentryBox Image"
readonly error_hub_image_repository="ghcr.io/pbuchman/sentrybox"
readonly error_hub_system_node="${error_hub_prefix}/opt/nodejs/current/bin/node"
readonly error_hub_system_node_version="v22.23.2"

# Compose reads the persistent runtime reference list through this path. Tests
# redirect it into their disposable prefix; production uses the canonical path.
export ERROR_HUB_RUNTIME_ENV_FILE="${error_hub_runtime_environment_file}"

error_hub_require_command() {
  local eh_command_name="$1"
  if ! command -v "${eh_command_name}" >/dev/null 2>&1; then
    printf 'Required executable is unavailable: %s\n' "${eh_command_name}" >&2
    return 1
  fi
}

error_hub_require_root_private_directory() {
  local eh_directory="$1"
  local eh_description="$2"
  local eh_attributes
  if [[ ! -d "${eh_directory}" || -L "${eh_directory}" ]]; then
    printf '%s must be a regular directory.\n' "${eh_description}" >&2
    return 1
  fi
  eh_attributes="$(stat -c '%a:%u:%g' "${eh_directory}")"
  if [[ "${eh_attributes}" != "700:0:0" ]]; then
    printf '%s must be root-owned with mode 0700.\n' "${eh_description}" >&2
    return 1
  fi
}

error_hub_require_root_private_file() {
  local eh_file="$1"
  local eh_description="$2"
  local eh_attributes
  if [[ ! -f "${eh_file}" || -L "${eh_file}" ]]; then
    printf '%s must be a regular file.\n' "${eh_description}" >&2
    return 1
  fi
  eh_attributes="$(stat -c '%a:%u:%g:%h' "${eh_file}")"
  if [[ "${eh_attributes}" != "600:0:0:1" ]]; then
    printf '%s must be root-owned, mode 0600, and singly linked.\n' \
      "${eh_description}" >&2
    return 1
  fi
}

error_hub_publish_root_private_file() {
  local eh_temporary_file="$1"
  local eh_destination_file="$2"
  local eh_description="$3"
  if [[ "${eh_destination_file%/*}" != "${error_hub_state_directory}" ]]; then
    printf '%s destination must be directly inside deployment state.\n' \
      "${eh_description}" >&2
    return 1
  fi
  error_hub_require_root_private_directory \
    "${error_hub_state_directory}" "SentryBox deployment state directory" || return $?
  if [[ ! -f "${eh_temporary_file}" || -L "${eh_temporary_file}" ]] \
    || [[ "$(stat -c '%h' "${eh_temporary_file}")" != "1" ]]; then
    printf '%s temporary file must be regular and singly linked.\n' \
      "${eh_description}" >&2
    return 1
  fi
  if [[ "$(stat -c '%u:%g' "${eh_temporary_file}")" != "0:0" ]] \
    && ! chown 0:0 "${eh_temporary_file}"; then
    rm -f -- "${eh_temporary_file}"
    return 1
  fi
  if ! chmod 0600 "${eh_temporary_file}" \
    || ! mv -f "${eh_temporary_file}" "${eh_destination_file}"; then
    rm -f -- "${eh_temporary_file}"
    return 1
  fi
  error_hub_require_root_private_file \
    "${eh_destination_file}" "${eh_description}"
}

error_hub_validate_caddy() {
  install -d -m 0700 \
    "${error_hub_caddy_validation_config}" \
    "${error_hub_caddy_validation_data}"
  XDG_CONFIG_HOME="${error_hub_caddy_validation_config}" \
    XDG_DATA_HOME="${error_hub_caddy_validation_data}" \
    caddy validate --config "${error_hub_caddy_config}"
}

error_hub_apply_caddy_fragment() {
  local eh_source_fragment="$1"
  local eh_temporary_fragment="${error_hub_caddy_fragment}.tmp.$$"
  if [[ ! -f "${eh_source_fragment}" || -L "${eh_source_fragment}" ]]; then
    printf 'Caddy route source must be a regular checked-in file: %s\n' \
      "${eh_source_fragment}" >&2
    return 1
  fi
  if ! install -m 0644 "${eh_source_fragment}" "${eh_temporary_fragment}"; then
    rm -f "${eh_temporary_fragment}"
    return 1
  fi
  if ! mv -f "${eh_temporary_fragment}" "${error_hub_caddy_fragment}"; then
    rm -f "${eh_temporary_fragment}"
    return 1
  fi
  error_hub_validate_caddy >/dev/null || return $?
  systemctl reload caddy
}

error_hub_require_runtime_environment() {
  local -a eh_lines=()
  error_hub_require_root_private_directory \
    "${error_hub_state_directory}" "SentryBox deployment state directory" || return $?
  error_hub_require_root_private_file \
    "${error_hub_runtime_environment_file}" \
    "SentryBox runtime environment" || return $?
  mapfile -t eh_lines <"${error_hub_runtime_environment_file}"
  if (( ${#eh_lines[@]} < 1 || ${#eh_lines[@]} > 2 )) \
    || [[ "${eh_lines[0]}" != "ERROR_HUB_REQUIRED_SECRET_REFERENCES=${error_hub_required_secret_references}" ]]; then
    printf 'SentryBox runtime environment must require exactly %s and at most one Grafana URL.\n' \
      "${error_hub_required_secret_references}" >&2
    return 1
  fi
  if (( ${#eh_lines[@]} == 2 )) \
    && ! error_hub_valid_grafana_environment_line "${eh_lines[1]}"; then
    printf 'SentryBox Grafana Explore URL must be credential-free HTTPS with orgId and datasource.\n' >&2
    return 1
  fi
  error_hub_require_service_credentials
}

error_hub_require_service_credentials() {
  local -a eh_lines=()
  local eh_line eh_name eh_value
  local eh_dev_count=0 eh_prod_count=0
  if [[ ! -f "${error_hub_environment_file}" || -L "${error_hub_environment_file}" ]]; then
    printf 'SentryBox service credential file must be a regular file.\n' >&2
    return 1
  fi
  if [[ "$(stat -c '%a:%h' "${error_hub_environment_file}")" != "600:1" ]]; then
    printf 'SentryBox service credential file must be mode 0600 and singly linked.\n' >&2
    return 1
  fi
  mapfile -t eh_lines <"${error_hub_environment_file}"
  if (( ${#eh_lines[@]} != 2 )); then
    printf 'SentryBox service credential file must contain exactly CODE_AGENT_HMAC_DEV and CODE_AGENT_HMAC_PROD.\n' >&2
    return 1
  fi
  for eh_line in "${eh_lines[@]}"; do
    if [[ "${eh_line}" != *=* ]]; then
      printf 'SentryBox service credential file must contain only non-empty KEY=VALUE entries.\n' >&2
      return 1
    fi
    eh_name="${eh_line%%=*}"
    eh_value="${eh_line#*=}"
    if [[ -z "${eh_value}" ]]; then
      printf 'SentryBox service credential file must contain only non-empty KEY=VALUE entries.\n' >&2
      return 1
    fi
    case "${eh_name}" in
      CODE_AGENT_HMAC_DEV) ((eh_dev_count += 1)) ;;
      CODE_AGENT_HMAC_PROD) ((eh_prod_count += 1)) ;;
      *)
        printf 'SentryBox service credential file must contain exactly CODE_AGENT_HMAC_DEV and CODE_AGENT_HMAC_PROD.\n' >&2
        return 1
        ;;
    esac
  done
  if (( eh_dev_count != 1 || eh_prod_count != 1 )); then
    printf 'SentryBox service credential file must contain exactly CODE_AGENT_HMAC_DEV and CODE_AGENT_HMAC_PROD.\n' >&2
    return 1
  fi
}

error_hub_valid_grafana_environment_line() {
  local eh_line="$1"
  local eh_port=""
  if [[ ! "${eh_line}" =~ ^ERROR_HUB_GRAFANA_EXPLORE_URL=https://[A-Za-z0-9.-]+(:([0-9]{1,5}))?/explore\?orgId=[0-9]+\&datasource=[A-Za-z0-9_-]{1,128}$ ]]; then
    return 1
  fi
  eh_port="${BASH_REMATCH[2]:-}"
  [[ -z "${eh_port}" ]] || (( 10#${eh_port} <= 65535 ))
}

error_hub_require_immutable_image() {
  local eh_candidate_image="${1:-}"
  if [[ ! "${eh_candidate_image}" =~ ^ghcr\.io/pbuchman/sentrybox@sha256:[0-9a-f]{64}$ ]]; then
    printf 'An immutable SentryBox image digest is required; tags including latest are forbidden.\n' >&2
    return 1
  fi
}

error_hub_require_sha() {
  local eh_candidate_sha="${1:-}"
  if [[ ! "${eh_candidate_sha}" =~ ^[0-9a-f]{40}$ ]]; then
    printf 'A full lowercase 40-character commit SHA is required.\n' >&2
    return 1
  fi
}

error_hub_require_private_origin() {
  local eh_candidate_origin="${1:-}"
  if [[ ! "${eh_candidate_origin}" =~ ^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?$ ]]; then
    printf 'ERROR_HUB_PRIVATE_ORIGIN must be an exact HTTPS origin.\n' >&2
    return 1
  fi
}

error_hub_require_free_space() {
  local eh_disk_path="$1"
  local eh_available_kib
  eh_available_kib="$(df -Pk "${eh_disk_path}" | awk 'NR == 2 { print $4 }')"
  if [[ ! "${eh_available_kib}" =~ ^[0-9]+$ ]] \
    || (( eh_available_kib < 15 * 1024 * 1024 )); then
    printf 'At least 15 GiB of free Home Dev disk space is required.\n' >&2
    return 1
  fi
}

error_hub_git() {
  git -c "safe.directory=${error_hub_checkout}" \
    -C "${error_hub_checkout}" "$@"
}

error_hub_normalize_checkout_objects() {
  local eh_git_directory="${error_hub_checkout}/.git"
  local eh_objects_directory="${eh_git_directory}/objects"
  local eh_entry
  if [[ ! -d "${eh_git_directory}" || -L "${eh_git_directory}" \
    || ! -d "${eh_objects_directory}" || -L "${eh_objects_directory}" ]]; then
    printf 'Canonical SentryBox checkout must use a regular Git object store.\n' >&2
    return 1
  fi
  while IFS= read -r -d '' eh_entry; do
    if [[ -L "${eh_entry}" \
      || ( ! -d "${eh_entry}" && ! -f "${eh_entry}" ) ]]; then
      printf 'Canonical SentryBox Git object store contains an unsafe entry.\n' >&2
      return 1
    fi
  done < <(find "${eh_objects_directory}" -xdev -print0)
  find "${eh_objects_directory}" -xdev -type d -exec chmod 0755 {} + \
    && find "${eh_objects_directory}" -xdev -type f -exec chmod 0644 {} +
}

error_hub_fetch_origin_main() {
  local eh_fetch_status=0
  error_hub_normalize_checkout_objects || return $?
  (
    umask 022
    error_hub_git fetch --quiet origin main
  ) || eh_fetch_status=$?
  error_hub_normalize_checkout_objects || return $?
  return "${eh_fetch_status}"
}

error_hub_require_system_node() {
  local eh_node_attributes eh_node_version
  if [[ ! -f "${error_hub_system_node}" || -L "${error_hub_system_node}" \
    || ! -x "${error_hub_system_node}" ]]; then
    printf 'SentryBox requires the root-owned system Node.js %s executable at /opt/nodejs/current/bin/node.\n' \
      "${error_hub_system_node_version}" >&2
    return 1
  fi
  eh_node_attributes="$(stat -c '%a:%u:%g:%h' "${error_hub_system_node}")" \
    || return $?
  if [[ "${eh_node_attributes}" != "755:0:0:1" ]]; then
    printf 'SentryBox requires the root-owned system Node.js %s executable at /opt/nodejs/current/bin/node.\n' \
      "${error_hub_system_node_version}" >&2
    return 1
  fi
  eh_node_version="$("${error_hub_system_node}" --version 2>/dev/null)" \
    || return $?
  if [[ "${eh_node_version}" != "${error_hub_system_node_version}" ]]; then
    printf 'SentryBox requires the root-owned system Node.js %s executable at /opt/nodejs/current/bin/node.\n' \
      "${error_hub_system_node_version}" >&2
    return 1
  fi
}

# The deploy unit uses UMask=0077 for state, but public tracked assets must keep
# their repository modes so the non-root runtime can read and execute them.
error_hub_checkout_detached() (
  local eh_checkout_sha="$1"
  umask 022
  error_hub_git checkout --quiet --detach "${eh_checkout_sha}"
)

error_hub_read_state() {
  local eh_requested_state_file="$1"
  local eh_state_line eh_state_key eh_state_value
  local eh_state_image="" eh_state_origin="" eh_state_sha=""
  error_hub_require_root_private_directory \
    "${error_hub_state_directory}" "SentryBox deployment state directory" || return $?
  error_hub_require_root_private_file \
    "${eh_requested_state_file}" "Deployment state" || return $?
  while IFS= read -r eh_state_line || [[ -n "${eh_state_line}" ]]; do
    [[ "${eh_state_line}" == *=* ]] || {
      printf 'Deployment state contains a malformed line.\n' >&2
      return 1
    }
    eh_state_key="${eh_state_line%%=*}"
    eh_state_value="${eh_state_line#*=}"
    case "${eh_state_key}" in
      ERROR_HUB_IMAGE)
        [[ -z "${eh_state_image}" ]] || return 1
        eh_state_image="${eh_state_value}"
        ;;
      ERROR_HUB_PRIVATE_ORIGIN)
        [[ -z "${eh_state_origin}" ]] || return 1
        eh_state_origin="${eh_state_value}"
        ;;
      ERROR_HUB_DEPLOYED_SHA)
        [[ -z "${eh_state_sha}" ]] || return 1
        eh_state_sha="${eh_state_value}"
        ;;
      *)
        printf 'Deployment state contains an unsupported key.\n' >&2
        return 1
        ;;
    esac
  done <"${eh_requested_state_file}"
  error_hub_require_immutable_image "${eh_state_image}"
  error_hub_require_private_origin "${eh_state_origin}"
  error_hub_require_sha "${eh_state_sha}"
  ERROR_HUB_STATE_IMAGE="${eh_state_image}"
  ERROR_HUB_STATE_PRIVATE_ORIGIN="${eh_state_origin}"
  ERROR_HUB_STATE_SHA="${eh_state_sha}"
}

error_hub_write_state() {
  local eh_requested_state_file="$1"
  local eh_requested_image="$2"
  local eh_requested_origin="$3"
  local eh_requested_sha="$4"
  local eh_state_temporary
  error_hub_require_immutable_image "${eh_requested_image}"
  error_hub_require_private_origin "${eh_requested_origin}"
  error_hub_require_sha "${eh_requested_sha}"
  error_hub_require_root_private_directory \
    "${error_hub_state_directory}" "SentryBox deployment state directory" || return $?
  umask 077
  eh_state_temporary="$(mktemp "${eh_requested_state_file}.tmp.XXXXXX")"
  if ! {
    printf 'ERROR_HUB_IMAGE=%s\n' "${eh_requested_image}"
    printf 'ERROR_HUB_PRIVATE_ORIGIN=%s\n' "${eh_requested_origin}"
    printf 'ERROR_HUB_DEPLOYED_SHA=%s\n' "${eh_requested_sha}"
  } >"${eh_state_temporary}"; then
    rm -f "${eh_state_temporary}"
    return 1
  fi
  error_hub_publish_root_private_file \
    "${eh_state_temporary}" "${eh_requested_state_file}" "Deployment state"
}

error_hub_compose_up() {
  local eh_compose_image="$1"
  local eh_compose_origin="$2"
  error_hub_require_immutable_image "${eh_compose_image}" || return $?
  error_hub_require_private_origin "${eh_compose_origin}" || return $?
  error_hub_require_runtime_environment || return $?
  ERROR_HUB_IMAGE="${eh_compose_image}" \
    ERROR_HUB_PRIVATE_ORIGIN="${eh_compose_origin}" \
    docker compose --file "${error_hub_compose_file}" \
      up -d --wait --remove-orphans
}

error_hub_synthetic_database_operation() {
  local eh_synthetic_image="$1"
  local eh_synthetic_command="$2"
  local eh_synthetic_context="$3"
  local eh_synthetic_uid="${ERROR_HUB_RUNTIME_UID:-1000}"
  local eh_synthetic_gid="${ERROR_HUB_RUNTIME_GID:-1000}"
  error_hub_require_immutable_image "${eh_synthetic_image}"
  if [[ ! "${eh_synthetic_uid}" =~ ^[1-9][0-9]*$ \
    || ! "${eh_synthetic_gid}" =~ ^[1-9][0-9]*$ ]]; then
    printf 'Synthetic database checks require a numeric non-root runtime UID and GID.\n' >&2
    return 1
  fi
  docker run --rm --interactive \
    --user "${eh_synthetic_uid}:${eh_synthetic_gid}" \
    --read-only \
    --cap-drop ALL \
    --security-opt no-new-privileges:true \
    --tmpfs /tmp:size=16m,mode=1777 \
    --label "sentrybox-check=${eh_synthetic_command}" \
    --mount "type=bind,src=${error_hub_data_directory},dst=/data" \
    --entrypoint node \
    "${eh_synthetic_image}" \
    --input-type=module - "${eh_synthetic_command}" "${eh_synthetic_context}" \
    <"${error_hub_database_operations}"
}

error_hub_recover_synthetic_public_check() (
  set -euo pipefail
  local eh_synthetic_image="$1"
  local eh_candidate eh_candidate_basename
  local -a eh_contexts=()
  error_hub_require_immutable_image "${eh_synthetic_image}"
  shopt -s nullglob
  for eh_candidate in \
    "${error_hub_data_directory}"/synthetic-public-check.*.json; do
    eh_candidate_basename="${eh_candidate##*/}"
    if [[ "${eh_candidate_basename}" =~ ^synthetic-public-check\.[0-9]+\.json$ ]]; then
      eh_contexts+=("${eh_candidate}")
    fi
  done
  if (( ${#eh_contexts[@]} > 1 )); then
    printf 'More than one pending synthetic public check requires manual recovery.\n' >&2
    exit 1
  fi
  if (( ${#eh_contexts[@]} == 0 )); then
    exit 0
  fi
  eh_candidate="${eh_contexts[0]}"
  if [[ ! -f "${eh_candidate}" || -L "${eh_candidate}" ]]; then
    printf 'Synthetic public check recovery requires a regular context file.\n' >&2
    exit 1
  fi
  eh_candidate_basename="${eh_candidate##*/}"
  error_hub_synthetic_database_operation \
    "${eh_synthetic_image}" synthetic-cleanup "/data/${eh_candidate_basename}" \
    >/dev/null || exit $?
  if [[ -e "${eh_candidate}" ]]; then
    printf 'Synthetic public check cleanup did not remove its context.\n' >&2
    exit 1
  fi
)

error_hub_require_response_header() {
  local eh_header_file="$1"
  local eh_header_name="$2"
  local eh_header_value="$3"
  tr -d '\r' <"${eh_header_file}" \
    | grep -Fxi -- "${eh_header_name}: ${eh_header_value}" >/dev/null
}

error_hub_run_synthetic_public_check() (
  set -euo pipefail
  local eh_synthetic_image="$1"
  local eh_route="${2:-loopback}"
  local eh_context_basename="synthetic-public-check.${BASHPID}.json"
  local eh_container_context="/data/${eh_context_basename}"
  local eh_host_context="${error_hub_data_directory}/${eh_context_basename}"
  local eh_options_headers="${error_hub_state_directory}/${eh_context_basename}.options.headers"
  local eh_post_headers="${error_hub_state_directory}/${eh_context_basename}.post.headers"
  local eh_post_response="${error_hub_state_directory}/${eh_context_basename}.response.json"
  case "${eh_route}" in
    loopback|public) ;;
    *)
      printf 'Synthetic public check route is invalid.\n' >&2
      exit 1
      ;;
  esac

  # shellcheck disable=SC2317,SC2329 # Invoked indirectly by the EXIT trap below.
  cleanup_synthetic_public_check() {
    local eh_exit_status=$?
    local eh_cleanup_status=0
    trap - EXIT INT TERM
    set +e
    if [[ -e "${eh_host_context}" ]]; then
      if [[ -f "${eh_host_context}" && ! -L "${eh_host_context}" ]]; then
        error_hub_synthetic_database_operation \
          "${eh_synthetic_image}" synthetic-cleanup "${eh_container_context}" \
          >/dev/null || eh_cleanup_status=$?
        if (( eh_cleanup_status == 0 )) && [[ -e "${eh_host_context}" ]]; then
          eh_cleanup_status=1
        fi
      else
        eh_cleanup_status=1
      fi
    fi
    rm -f "${eh_options_headers}" "${eh_post_headers}" "${eh_post_response}"
    if (( eh_exit_status == 0 && eh_cleanup_status != 0 )); then
      eh_exit_status="${eh_cleanup_status}"
    fi
    exit "${eh_exit_status}"
  }
  trap cleanup_synthetic_public_check EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM

  local eh_context_json eh_project_id eh_public_key eh_dsn eh_event_id
  local eh_envelope eh_endpoint eh_options_status eh_post_status
  eh_context_json="$(
    error_hub_synthetic_database_operation \
      "${eh_synthetic_image}" synthetic-prepare "${eh_container_context}"
  )" || exit $?
  [[ -f "${eh_host_context}" && ! -L "${eh_host_context}" ]] || exit 1
  eh_project_id="$(jq --raw-output '.projectId' <<<"${eh_context_json}")" || exit $?
  eh_public_key="$(jq --raw-output '.publicKey' <<<"${eh_context_json}")" || exit $?
  eh_dsn="$(jq --raw-output '.dsn' <<<"${eh_context_json}")" || exit $?
  eh_event_id="$(jq --raw-output '.eventId' <<<"${eh_context_json}")" || exit $?
  eh_envelope="$(jq --raw-output '.envelope' <<<"${eh_context_json}")" || exit $?
  [[ "${eh_project_id}" =~ ^[1-9][0-9]*$ ]] || exit 1
  [[ "${eh_public_key}" =~ ^[0-9a-f]{64}$ ]] || exit 1
  [[ "${eh_event_id}" =~ ^[0-9a-f]{32}$ ]] || exit 1
  [[ "${eh_dsn}" == "https://${eh_public_key}@errors.intexuraos.cloud/${eh_project_id}" ]] || exit 1
  local eh_origin='https://deployment-health.invalid'
  if [[ "${eh_route}" == "public" ]]; then
    eh_endpoint="https://errors.intexuraos.cloud/api/${eh_project_id}/envelope/?sentry_version=7&sentry_key=${eh_public_key}&sentry_client=sentry.javascript.node%2F8.55.0"
  else
    eh_endpoint="http://127.0.0.1:8140/api/${eh_project_id}/envelope/?sentry_version=7&sentry_key=${eh_public_key}&sentry_client=sentry.javascript.node%2F8.55.0"
  fi

  eh_options_status="$(
    curl --fail --silent --show-error --connect-timeout 2 --max-time 10 \
      --request OPTIONS \
      --header 'Host: errors.intexuraos.cloud' \
      --header "Origin: ${eh_origin}" \
      --header 'Access-Control-Request-Method: POST' \
      --header 'Access-Control-Request-Headers: content-type,x-sentry-auth' \
      --dump-header "${eh_options_headers}" \
      --output /dev/null \
      --write-out '%{http_code}' \
      "${eh_endpoint}"
  )" || exit $?
  [[ "${eh_options_status}" == "204" ]] || exit 1
  error_hub_require_response_header \
    "${eh_options_headers}" access-control-allow-origin "${eh_origin}" || exit $?
  error_hub_require_response_header \
    "${eh_options_headers}" access-control-allow-methods 'POST, OPTIONS' || exit $?
  error_hub_require_response_header \
    "${eh_options_headers}" access-control-allow-headers \
    'Content-Type, Content-Encoding, X-Sentry-Auth' || exit $?

  eh_post_status="$(
    printf '%s' "${eh_envelope}" \
      | curl --fail --silent --show-error --connect-timeout 2 --max-time 10 \
        --request POST \
        --header 'Host: errors.intexuraos.cloud' \
        --header "Origin: ${eh_origin}" \
        --header 'Content-Type: application/x-sentry-envelope' \
        --header "X-Sentry-Auth: Sentry sentry_version=7, sentry_client=sentry.javascript.node%2F8.55.0, sentry_key=${eh_public_key}" \
        --data-binary @- \
        --dump-header "${eh_post_headers}" \
        --output "${eh_post_response}" \
        --write-out '%{http_code}' \
        "${eh_endpoint}"
  )" || exit $?
  [[ "${eh_post_status}" == "200" ]] || exit 1
  error_hub_require_response_header \
    "${eh_post_headers}" access-control-allow-origin "${eh_origin}" || exit $?
  jq --exit-status --arg event_id "${eh_event_id}" \
    'type == "object" and keys == ["id"] and .id == $event_id' \
    "${eh_post_response}" >/dev/null || exit $?
  error_hub_synthetic_database_operation \
    "${eh_synthetic_image}" synthetic-verify "${eh_container_context}" \
    >/dev/null || exit $?
)

error_hub_health_checks() {
  local eh_health_origin="$1"
  local eh_health_image="$2"
  error_hub_require_private_origin "${eh_health_origin}"
  error_hub_require_immutable_image "${eh_health_image}"
  curl --fail --silent --show-error --connect-timeout 2 --max-time 5 \
    --header "Host: ${eh_health_origin#https://}" \
    http://127.0.0.1:8141/health/ready >/dev/null || return $?
  curl --fail --silent --show-error --connect-timeout 2 --max-time 5 \
    https://errors.intexuraos.cloud/health/live >/dev/null || return $?
  error_hub_run_synthetic_public_check "${eh_health_image}" loopback
}

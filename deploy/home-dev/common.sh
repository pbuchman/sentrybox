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

readonly error_hub_checkout="${error_hub_prefix}/home/pbuchman/deploy/intexura-error-hub"
readonly error_hub_service_root="${error_hub_prefix}/home/pbuchman/services/intexura-error-hub"
readonly error_hub_environment_file="${error_hub_service_root}/env"
readonly error_hub_data_directory="${error_hub_service_root}/data"
readonly error_hub_database="${error_hub_data_directory}/error-hub.sqlite"
readonly error_hub_backup_directory="${error_hub_prefix}/home/pbuchman/services/intexura-error-hub-backups"
readonly error_hub_state_directory="${error_hub_prefix}/var/lib/intexura-error-hub-deploy"
readonly error_hub_lock_file="${error_hub_prefix}/run/lock/intexura-error-hub-deploy.lock"
readonly error_hub_request_file="${error_hub_state_directory}/deploy-request.json"
readonly error_hub_current_state="${error_hub_state_directory}/current.env"
readonly error_hub_previous_state="${error_hub_state_directory}/previous.env"
readonly error_hub_compose_file="${error_hub_checkout}/deploy/home-dev/compose.yaml"
readonly error_hub_project_config="${error_hub_checkout}/deploy/home-dev/config.example.json"
readonly error_hub_database_operations="${error_hub_checkout}/deploy/home-dev/database-operations.mjs"
readonly error_hub_caddy_fragment="${error_hub_prefix}/etc/caddy/Caddyfile.d/intexura-error-hub.caddy"
readonly error_hub_caddy_config="${error_hub_prefix}/etc/caddy/Caddyfile"
readonly error_hub_repository="pbuchman/intexura-error-hub"
readonly error_hub_workflow="Release Error Hub Image"
readonly error_hub_image_repository="ghcr.io/pbuchman/intexura-error-hub"

error_hub_require_command() {
  local eh_command_name="$1"
  if ! command -v "${eh_command_name}" >/dev/null 2>&1; then
    printf 'Required executable is unavailable: %s\n' "${eh_command_name}" >&2
    return 1
  fi
}

error_hub_require_immutable_image() {
  local eh_candidate_image="${1:-}"
  if [[ ! "${eh_candidate_image}" =~ ^ghcr\.io/pbuchman/intexura-error-hub@sha256:[0-9a-f]{64}$ ]]; then
    printf 'An immutable Error Hub image digest is required; tags including latest are forbidden.\n' >&2
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

error_hub_read_state() {
  local eh_requested_state_file="$1"
  local eh_state_line eh_state_key eh_state_value
  local eh_state_image="" eh_state_origin="" eh_state_sha=""
  [[ -f "${eh_requested_state_file}" && ! -L "${eh_requested_state_file}" ]] || {
    printf 'Deployment state is unavailable: %s\n' "${eh_requested_state_file}" >&2
    return 1
  }
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
  local eh_state_temporary="${eh_requested_state_file}.tmp.$$"
  error_hub_require_immutable_image "${eh_requested_image}"
  error_hub_require_private_origin "${eh_requested_origin}"
  error_hub_require_sha "${eh_requested_sha}"
  mkdir -p "${error_hub_state_directory}"
  umask 077
  {
    printf 'ERROR_HUB_IMAGE=%s\n' "${eh_requested_image}"
    printf 'ERROR_HUB_PRIVATE_ORIGIN=%s\n' "${eh_requested_origin}"
    printf 'ERROR_HUB_DEPLOYED_SHA=%s\n' "${eh_requested_sha}"
  } >"${eh_state_temporary}"
  chmod 0600 "${eh_state_temporary}"
  if ! mv -f "${eh_state_temporary}" "${eh_requested_state_file}"; then
    rm -f "${eh_state_temporary}"
    return 1
  fi
}

error_hub_compose_up() {
  local eh_compose_image="$1"
  local eh_compose_origin="$2"
  error_hub_require_immutable_image "${eh_compose_image}"
  error_hub_require_private_origin "${eh_compose_origin}"
  ERROR_HUB_IMAGE="${eh_compose_image}" \
    ERROR_HUB_PRIVATE_ORIGIN="${eh_compose_origin}" \
    docker compose --file "${error_hub_compose_file}" \
      up -d --wait --remove-orphans
}

error_hub_synthetic_database_operation() {
  local eh_synthetic_image="$1"
  local eh_synthetic_command="$2"
  local eh_synthetic_context="$3"
  error_hub_require_immutable_image "${eh_synthetic_image}"
  docker run --rm --interactive \
    --user 0:0 \
    --read-only \
    --cap-drop ALL \
    --security-opt no-new-privileges:true \
    --tmpfs /tmp:size=16m,mode=1777 \
    --label "error-hub-check=${eh_synthetic_command}" \
    --mount "type=bind,src=${error_hub_data_directory},dst=/data" \
    --mount "type=bind,src=${error_hub_state_directory},dst=/state" \
    --entrypoint node \
    "${eh_synthetic_image}" \
    --input-type=module - "${eh_synthetic_command}" "${eh_synthetic_context}" \
    <"${error_hub_database_operations}"
}

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
  local eh_context_basename="synthetic-public-check.${BASHPID}.json"
  local eh_container_context="/state/${eh_context_basename}"
  local eh_host_context="${error_hub_state_directory}/${eh_context_basename}"
  local eh_options_headers="${error_hub_state_directory}/${eh_context_basename}.options.headers"
  local eh_post_headers="${error_hub_state_directory}/${eh_context_basename}.post.headers"
  local eh_post_response="${error_hub_state_directory}/${eh_context_basename}.response.json"
  local eh_prepared=0

  # shellcheck disable=SC2329 # Invoked indirectly by the EXIT trap below.
  cleanup_synthetic_public_check() {
    local eh_exit_status=$?
    local eh_cleanup_status=0
    trap - EXIT INT TERM
    set +e
    if (( eh_prepared == 1 )); then
      error_hub_synthetic_database_operation \
        "${eh_synthetic_image}" synthetic-cleanup "${eh_container_context}" \
        >/dev/null || eh_cleanup_status=$?
    fi
    rm -f "${eh_host_context}" "${eh_options_headers}" \
      "${eh_post_headers}" "${eh_post_response}"
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
  eh_prepared=1
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
  eh_endpoint="http://127.0.0.1:8140/api/${eh_project_id}/envelope/?sentry_version=7&sentry_key=${eh_public_key}&sentry_client=sentry.javascript.node%2F8.55.0"

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
  error_hub_run_synthetic_public_check "${eh_health_image}"
}

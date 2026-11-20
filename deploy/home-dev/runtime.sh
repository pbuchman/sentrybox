#!/usr/bin/env bash
set -euo pipefail

script_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
readonly script_directory
# shellcheck source=deploy/home-dev/common.sh
source "${script_directory}/common.sh"

error_hub_read_state "${error_hub_current_state}"
case "${1:-}" in
  start)
    ERROR_HUB_PRIVATE_ORIGIN="${ERROR_HUB_STATE_PRIVATE_ORIGIN}" \
      "${script_directory}/preflight.sh" "${ERROR_HUB_STATE_IMAGE}"
    error_hub_compose_up "${ERROR_HUB_STATE_IMAGE}" "${ERROR_HUB_STATE_PRIVATE_ORIGIN}"
    ;;
  reload)
    error_hub_require_runtime_environment
    error_hub_compose_up "${ERROR_HUB_STATE_IMAGE}" "${ERROR_HUB_STATE_PRIVATE_ORIGIN}"
    ;;
  stop)
    ERROR_HUB_IMAGE="${ERROR_HUB_STATE_IMAGE}" \
      ERROR_HUB_PRIVATE_ORIGIN="${ERROR_HUB_STATE_PRIVATE_ORIGIN}" \
      error_hub_docker_compose stop --timeout 30 sentrybox
    ;;
  *)
    printf 'Usage: runtime.sh {start|reload|stop}\n' >&2
    exit 2
    ;;
esac

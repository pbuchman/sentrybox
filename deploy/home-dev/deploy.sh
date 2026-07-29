#!/usr/bin/env bash
set -euo pipefail

script_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly script_directory
# shellcheck source=deploy/home-dev/common.sh
source "${script_directory}/common.sh"
readonly database_operations="${script_directory}/database-operations.mjs"

for executable in caddy curl df docker flock git jq systemctl; do
  error_hub_require_command "${executable}"
done

mkdir -p "$(dirname "${error_hub_lock_file}")" "${error_hub_state_directory}"
umask 077
exec 9>"${error_hub_lock_file}"
if ! flock -n 9; then
  printf 'A SentryBox deployment is already in progress.\n' >&2
  exit 1
fi

claimed_request="${error_hub_state_directory}/deploy-request.processing.$$"
maintenance_active=0
migration_probe="${error_hub_state_directory}/migration-probe.sqlite"
original_checkout_sha=""
checkout_changed=0
deployment_committed=0
runtime_changed=0
had_previous=0
previous_image=""
private_origin=""

restore_normal_caddy() {
  local route_status=0
  install -m 0644 \
    "${error_hub_checkout}/deploy/home-dev/caddy-sentrybox.caddy" \
    "${error_hub_caddy_fragment}" || route_status=$?
  if (( route_status == 0 )); then
    caddy validate --config "${error_hub_caddy_config}" >/dev/null \
      || route_status=$?
  fi
  if (( route_status == 0 )); then
    systemctl reload caddy || route_status=$?
  fi
  return "${route_status}"
}

cleanup() {
  local exit_status=$?
  trap - EXIT INT TERM
  set +e
  rm -f "${claimed_request}" "${migration_probe}" "${migration_probe}-wal" "${migration_probe}-shm"
  if (( runtime_changed == 1 && deployment_committed == 0 )); then
    runtime_restore_status=0
    if (( had_previous == 1 )); then
      "${script_directory}/rollback.sh" || runtime_restore_status=$?
    else
      ERROR_HUB_IMAGE="${resolved_image:-}" \
        ERROR_HUB_PRIVATE_ORIGIN="${private_origin:-}" \
        docker compose --file "${error_hub_compose_file}" \
          stop --timeout 30 sentrybox >/dev/null || runtime_restore_status=$?
    fi
    if (( exit_status == 0 && runtime_restore_status != 0 )); then
      exit_status="${runtime_restore_status}"
    fi
  fi
  if (( checkout_changed == 1 && deployment_committed == 0 )) \
    && [[ -n "${original_checkout_sha}" ]]; then
    error_hub_git checkout --quiet --detach "${original_checkout_sha}"
    checkout_restore_status=$?
    if (( exit_status == 0 && checkout_restore_status != 0 )); then
      exit_status="${checkout_restore_status}"
    fi
  fi
  if (( maintenance_active == 1 )); then
    restore_status=0
    restore_normal_caddy || restore_status=$?
    if (( exit_status == 0 && restore_status != 0 )); then
      exit_status="${restore_status}"
    fi
  fi
  exit "${exit_status}"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [[ ! -e "${error_hub_request_file}" ]]; then
  printf 'A deployment request is required.\n' >&2
  exit 1
fi
mv "${error_hub_request_file}" "${claimed_request}"
readonly claimed_request
if [[ ! -f "${claimed_request}" || -L "${claimed_request}" ]]; then
  printf 'A regular deployment request is required.\n' >&2
  exit 1
fi
request_size="$(stat -c '%s' "${claimed_request}")"
request_mode="$(stat -c '%a' "${claimed_request}")"
request_owner="$(stat -c '%u' "${claimed_request}")"
request_links="$(stat -c '%h' "${claimed_request}")"
if (( request_size < 1 || request_size > 4096 )) \
  || [[ "${request_mode}" != "600" || "${request_owner}" != "0" || "${request_links}" != "1" ]]; then
  printf 'Deployment request ownership, mode, link count, or size is invalid.\n' >&2
  exit 1
fi

request_sha="$(
  jq --exit-status --raw-output '
    if type == "object"
      and keys == ["headSha", "repository", "version", "workflow"]
      and .version == 1
      and .repository == "pbuchman/sentrybox"
      and .workflow == "Release SentryBox Image"
      and (.headSha | type == "string" and test("^[0-9a-f]{40}$"))
    then .headSha
    else error("deployment request identity is invalid")
    end
  ' "${claimed_request}"
)"
readonly request_sha
error_hub_require_sha "${request_sha}"
error_hub_require_free_space "${error_hub_service_root}"

repository_remote="$(error_hub_git remote get-url origin)"
readonly repository_remote
case "${repository_remote}" in
  https://github.com/pbuchman/sentrybox.git|git@github.com:pbuchman/sentrybox.git) ;;
  *)
    printf 'Canonical SentryBox checkout has an unexpected origin.\n' >&2
    exit 1
    ;;
esac
if [[ -n "$(error_hub_git status --porcelain --untracked-files=normal)" ]]; then
  printf 'Canonical SentryBox deployment checkout must be clean.\n' >&2
  exit 1
fi
original_checkout_sha="$(error_hub_git rev-parse HEAD)"
error_hub_require_sha "${original_checkout_sha}"
readonly original_checkout_sha
error_hub_git fetch --quiet origin main
remote_main="$(error_hub_git rev-parse origin/main)"
readonly remote_main
if [[ "${remote_main}" != "${request_sha}" ]]; then
  printf 'Verified workflow SHA is not the current origin/main commit.\n' >&2
  exit 1
fi
error_hub_git cat-file -e "${request_sha}^{commit}"
error_hub_git checkout --quiet --detach "${request_sha}"
checkout_changed=1

readonly release_tag="${error_hub_image_repository}:sha-${request_sha}"
docker pull "${release_tag}" >/dev/null
resolved_image="$(
  docker image inspect --format '{{index .RepoDigests 0}}' "${release_tag}"
)"
readonly resolved_image
error_hub_require_immutable_image "${resolved_image}"

if [[ -f "${error_hub_current_state}" ]]; then
  error_hub_read_state "${error_hub_current_state}"
  had_previous=1
  previous_image="${ERROR_HUB_STATE_IMAGE}"
  private_origin="${ERROR_HUB_STATE_PRIVATE_ORIGIN}"
  install -m 0600 "${error_hub_current_state}" "${error_hub_previous_state}.tmp.$$"
  mv -f "${error_hub_previous_state}.tmp.$$" "${error_hub_previous_state}"
else
  readonly private_origin_file="${error_hub_state_directory}/private-origin"
  if [[ ! -f "${private_origin_file}" || -L "${private_origin_file}" ]]; then
    printf 'Initial deployment requires the installed private origin.\n' >&2
    exit 1
  fi
  IFS= read -r private_origin <"${private_origin_file}"
  error_hub_require_private_origin "${private_origin}"
  rm -f "${error_hub_previous_state}"
fi
readonly had_previous previous_image private_origin

ERROR_HUB_PRIVATE_ORIGIN="${private_origin}" \
  "${script_directory}/preflight.sh" "${resolved_image}"

maintenance_file="${error_hub_state_directory}/caddy-maintenance.caddy"
cat >"${maintenance_file}" <<'CADDY'
errors.intexuraos.cloud:80 {
	@ingest {
		method POST OPTIONS
		path_regexp envelope ^/api/[0-9]+/envelope/$
	}

	handle @ingest {
		header Retry-After "120"
		respond "temporarily unavailable" 503
	}

	@liveness {
		method GET
		path /health/live
	}

	handle @liveness {
		reverse_proxy 127.0.0.1:8140
	}

	handle {
		respond "not found" 404
	}
}
CADDY
install -m 0644 "${maintenance_file}" "${error_hub_caddy_fragment}"
rm -f "${maintenance_file}"
maintenance_active=1
caddy validate --config "${error_hub_caddy_config}" >/dev/null
systemctl reload caddy

backup_image="${resolved_image}"
if (( had_previous == 1 )); then
  backup_image="${previous_image}"
fi
readonly backup_image
"${script_directory}/backup.sh" predeploy "${backup_image}" >/dev/null

readonly predeploy_backup="${error_hub_backup_directory}/predeploy.sqlite"
if (( had_previous == 1 )) && [[ -f "${error_hub_database}" ]]; then
  if [[ ! -s "${predeploy_backup}" || -L "${predeploy_backup}" ]]; then
    printf 'Migration compatibility probe requires a safe pre-deployment backup.\n' >&2
    exit 1
  fi
  install -m 0600 "${predeploy_backup}" "${migration_probe}"
  docker run --rm --interactive \
    --user 0:0 \
    --read-only \
    --tmpfs /tmp:size=16m,mode=1777 \
    --label sentrybox-check=compatibility-new \
    --mount "type=bind,src=${error_hub_state_directory},dst=/probe" \
    --entrypoint node \
    "${resolved_image}" \
    --input-type=module - open-runtime \
    <"${database_operations}" >/dev/null
  docker run --rm --interactive \
    --user 0:0 \
    --read-only \
    --tmpfs /tmp:size=16m,mode=1777 \
    --label sentrybox-check=compatibility-previous \
    --mount "type=bind,src=${error_hub_state_directory},dst=/probe" \
    --entrypoint node \
    "${previous_image}" \
    --input-type=module - compatibility-read \
    <"${database_operations}" >/dev/null
  rm -f "${migration_probe}" "${migration_probe}-wal" "${migration_probe}-shm"
fi

deployment_status=0
runtime_changed=1
error_hub_compose_up "${resolved_image}" "${private_origin}" || deployment_status=$?
if (( deployment_status == 0 )); then
  error_hub_health_checks "${private_origin}" "${resolved_image}" || deployment_status=$?
fi
if (( deployment_status != 0 )); then
  printf 'New SentryBox image failed deployment health checks.\n' >&2
  exit "${deployment_status}"
fi

normal_route_status=0
restore_normal_caddy || normal_route_status=$?
if (( normal_route_status != 0 )); then
  printf 'Normal Caddy ingest routing could not be restored; deployment was not committed.\n' >&2
  exit "${normal_route_status}"
fi
public_route_status=0
error_hub_run_synthetic_public_check "${resolved_image}" public \
  || public_route_status=$?
if (( public_route_status != 0 )); then
  printf 'Public HTTPS ingest routing failed its deployment check.\n' >&2
  exit "${public_route_status}"
fi
maintenance_active=0

error_hub_write_state \
  "${error_hub_current_state}" \
  "${resolved_image}" \
  "${private_origin}" \
  "${request_sha}"
deployment_committed=1

printf 'SentryBox deployed at %s using %s.\n' "${request_sha}" "${resolved_image}"

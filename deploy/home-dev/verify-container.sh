#!/usr/bin/env bash
set -euo pipefail

readonly verify_image="${1:-intexura-error-hub:verify}"
verify_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
readonly verify_root
verify_uid="$(id -u)"
readonly verify_uid
verify_gid="$(id -g)"
readonly verify_gid
readonly verify_container="error-hub-verify-$$"
readonly verify_private_host="verify.error-hub.invalid:8443"
verify_temp="$(mktemp -d /tmp/error-hub-container.XXXXXX)"

cleanup() {
  docker rm --force "${verify_container}" >/dev/null 2>&1 || true
  case "${verify_temp}" in
    /tmp/error-hub-container.*) rm -rf -- "${verify_temp}" ;;
    *) printf 'Refusing to remove unexpected path: %s\n' "${verify_temp}" >&2 ;;
  esac
}
trap cleanup EXIT

if [[ "${verify_uid}" == "0" || "${verify_gid}" == "0" ]]; then
  printf 'Run the container verifier as a non-root user.\n' >&2
  exit 1
fi
if [[ "${verify_image}" == "latest" || "${verify_image}" == *:latest ]]; then
  printf 'Mutable latest images are not accepted.\n' >&2
  exit 1
fi

mkdir -p "${verify_temp}/data"
: >"${verify_temp}/env"
chmod 0600 "${verify_temp}/env"

if [[ "$#" -eq 0 ]]; then
  docker build --tag "${verify_image}" "${verify_root}"
elif ! docker image inspect "${verify_image}" >/dev/null 2>&1; then
  docker pull "${verify_image}"
fi

image_user="$(docker image inspect --format '{{.Config.User}}' "${verify_image}")"
readonly image_user
if [[ ! "${image_user}" =~ ^[1-9][0-9]*:[1-9][0-9]*$ ]]; then
  printf 'Image default user must be a numeric non-root UID:GID.\n' >&2
  exit 1
fi

docker run --detach \
  --name "${verify_container}" \
  --user "${verify_uid}:${verify_gid}" \
  --read-only \
  --tmpfs /tmp:size=64m,mode=1777 \
  --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --pids-limit 128 \
  --memory 512m \
  --publish 127.0.0.1::8080 \
  --publish 127.0.0.1::8081 \
  --mount "type=bind,src=${verify_temp}/data,dst=/data" \
  --mount "type=bind,src=${verify_temp}/env,dst=/run/secrets/error-hub-env,readonly" \
  --mount "type=bind,src=${verify_root}/deploy/home-dev/config.example.json,dst=/run/config/error-hub-projects.json,readonly" \
  --env ERROR_HUB_DATABASE_PATH=/data/error-hub.sqlite \
  --env ERROR_HUB_ENV_FILE=/run/secrets/error-hub-env \
  --env ERROR_HUB_PRIVATE_ORIGIN="https://${verify_private_host}" \
  --env ERROR_HUB_PUBLIC_HOST=0.0.0.0 \
  --env ERROR_HUB_PUBLIC_PORT=8080 \
  --env ERROR_HUB_PRIVATE_HOST=0.0.0.0 \
  --env ERROR_HUB_PRIVATE_PORT=8081 \
  --env ERROR_HUB_PUBLIC_INGEST_HOSTS=errors.intexuraos.cloud \
  --env ERROR_HUB_REQUIRED_SECRET_REFERENCES= \
  "${verify_image}" >/dev/null

public_port="$(docker port "${verify_container}" 8080/tcp | awk -F: 'NR==1 {print $NF}')"
readonly public_port
private_port="$(docker port "${verify_container}" 8081/tcp | awk -F: 'NR==1 {print $NF}')"
readonly private_port

ready=false
for _attempt in {1..40}; do
  if curl --fail --silent --connect-timeout 1 --max-time 2 \
    "http://127.0.0.1:${public_port}/health/live" >/dev/null 2>&1 \
    && curl --fail --silent --connect-timeout 1 --max-time 2 \
      --header "Host: ${verify_private_host}" \
      "http://127.0.0.1:${private_port}/health/ready" >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 0.5
done
if [[ "${ready}" != "true" ]]; then
  docker logs "${verify_container}" >&2
  exit 1
fi

runtime_user="$(docker inspect --format '{{.Config.User}}' "${verify_container}")"
readonly runtime_user
readonly_root="$(docker inspect --format '{{.HostConfig.ReadonlyRootfs}}' "${verify_container}")"
readonly readonly_root
memory_limit="$(docker inspect --format '{{.HostConfig.Memory}}' "${verify_container}")"
readonly memory_limit
pid_limit="$(docker inspect --format '{{.HostConfig.PidsLimit}}' "${verify_container}")"
readonly pid_limit
if [[ ! "${runtime_user}" =~ ^[1-9][0-9]*:[1-9][0-9]*$ ]]; then
  printf 'Running container user is not numeric non-root.\n' >&2
  exit 1
fi
if [[ "${readonly_root}" != "true" || "${memory_limit}" -le 0 || "${pid_limit}" -le 0 ]]; then
  printf 'Runtime hardening limits are missing.\n' >&2
  exit 1
fi
if docker exec "${verify_container}" touch /root-filesystem-must-be-read-only 2>/dev/null; then
  printf 'Container root filesystem is writable.\n' >&2
  exit 1
fi
if ! docker exec "${verify_container}" sh -c \
  'probe=/tmp/error-hub-write-test; : >"${probe}" && rm "${probe}"'; then
  printf 'Container tmpfs is not writable.\n' >&2
  exit 1
fi
if ! docker exec "${verify_container}" test -s /etc/ssl/certs/ca-certificates.crt; then
  printf 'Runtime CA certificate bundle is missing.\n' >&2
  exit 1
fi
if ! docker exec "${verify_container}" node \
  scripts/admin/validate-project-config.mjs \
  --config /run/config/error-hub-projects.json >/dev/null; then
  printf 'Runtime project configuration validator failed.\n' >&2
  exit 1
fi
if docker exec "${verify_container}" test -e /app/src \
  || docker exec "${verify_container}" test -e /app/test \
  || docker exec "${verify_container}" test -e /app/tsconfig.json; then
  printf 'Runtime image contains workspace source or test artifacts.\n' >&2
  exit 1
fi
if [[ ! -s "${verify_temp}/data/error-hub.sqlite" ]]; then
  printf 'SQLite database was not written to the bind-mounted data directory.\n' >&2
  exit 1
fi

docker stop --time 20 "${verify_container}" >/dev/null
exit_code="$(docker inspect --format '{{.State.ExitCode}}' "${verify_container}")"
readonly exit_code
if [[ "${exit_code}" != "0" ]]; then
  docker logs "${verify_container}" >&2
  printf 'Container did not stop cleanly.\n' >&2
  exit 1
fi

ERROR_HUB_IMAGE="ghcr.io/pbuchman/intexura-error-hub@sha256:0000000000000000000000000000000000000000000000000000000000000000" \
ERROR_HUB_PRIVATE_ORIGIN="https://${verify_private_host}" \
docker compose --file "${verify_root}/deploy/home-dev/compose.yaml" config >/dev/null

printf 'Error Hub container contract verified.\n'

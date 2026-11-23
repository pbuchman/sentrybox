#!/usr/bin/env bash
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
scratch="$(mktemp -d)"
readonly here scratch
readonly fixture="sentrybox-worker-relay-test-${RANDOM}-$$"
container_id=""

cleanup() {
  local status=$?
  if [[ -n "${container_id}" ]]; then
    if ((status != 0)); then
      docker logs "${container_id}" >&2 || true
      docker exec "${container_id}" systemctl list-jobs --no-pager >&2 || true
      docker exec "${container_id}" journalctl --no-pager --lines=50 \
        -u sentrybox-worker-relay.socket -u sentrybox-worker-relay.service \
        -u relay-fixture-bridge.service -u intexuraos-iptables.service >&2 || true
    fi
    docker rm --force "${container_id}" >/dev/null
  fi
  docker image rm "${fixture}" >/dev/null 2>&1 || true
  rm -rf -- "${scratch}"
}
trap cleanup EXIT

docker build --file "${here}/worker-relay.Dockerfile" --tag "${fixture}" "${here}/.."
container_id="$(docker create --name "${fixture}" --privileged --network none --cgroupns private \
  --tmpfs /run --tmpfs /run/lock \
  --add-host relay-fixture.example.ts.net:127.0.0.2 "${fixture}")"
docker start "${container_id}" >/dev/null
docker exec "${container_id}" /fixture/worker-relay-fixture.sh verify
docker stop --time 30 "${container_id}" >/dev/null
# A namespaced reboot(2) poweroff can terminate PID 1 with SIGINT (130).
exit_code="$(docker inspect --format '{{.State.ExitCode}}' "${container_id}")"
if [[ "${exit_code}" != 0 && "${exit_code}" != 130 ]]; then
  printf 'The relay test container exited with status %s during shutdown.\n' "${exit_code}" >&2
  exit 1
fi
docker cp "${container_id}:/fixture/shutdown-verified" "${scratch}/shutdown-verified"
test -f "${scratch}/shutdown-verified"
printf 'Verified shutdown closes the relay before the firewall stops.\n'

#!/usr/bin/env bats

setup() {
  repository_root="$(cd "${BATS_TEST_DIRNAME}/../../.." && pwd)"
  fixture_directory="$(mktemp -d "${BATS_TEST_TMPDIR}/network-contract.XXXXXX")"
  fake_bin="${fixture_directory}/bin"
  mkdir -p "${fake_bin}"

  export FAKE_TAILSCALE_STATUS_JSON="${fixture_directory}/tailscale-status.json"
  export FAKE_SERVE_BEFORE_JSON="${fixture_directory}/serve-before.json"
  export FAKE_SERVE_AFTER_JSON="${fixture_directory}/serve-after.json"
  export FAKE_SERVE_STATE="${fixture_directory}/serve-applied"
  export FAKE_CALL_LOG="${fixture_directory}/calls.log"
  export FAKE_CURL_EXIT_STATUS=0
  export ERROR_HUB_TAILSCALE_BIN="${fake_bin}/tailscale"
  export ERROR_HUB_SUDO_BIN="${fake_bin}/sudo"
  export ERROR_HUB_CURL_BIN="${fake_bin}/curl"
  export ERROR_HUB_NODE_BIN="$(command -v node)"
  unset ERROR_HUB_PRIVATE_ORIGIN

  printf '%s\n' '{"BackendState":"Running","Self":{"Online":true,"DNSName":"unit-test-node.example.ts.net."}}' >"${FAKE_TAILSCALE_STATUS_JSON}"
  printf '%s\n' '{}' >"${FAKE_SERVE_BEFORE_JSON}"
  write_exact_serve_mapping "${FAKE_SERVE_AFTER_JSON}"
  : >"${FAKE_CALL_LOG}"

  cat >"${ERROR_HUB_SUDO_BIN}" <<'SCRIPT'
#!/usr/bin/env bash
set -euo pipefail
exec "$@"
SCRIPT

  cat >"${ERROR_HUB_TAILSCALE_BIN}" <<'SCRIPT'
#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -eq 2 && "$1" == "status" && "$2" == "--json" ]]; then
  cat "${FAKE_TAILSCALE_STATUS_JSON}"
  exit 0
fi

if [[ "$#" -eq 3 && "$1" == "serve" && "$2" == "status" && "$3" == "--json" ]]; then
  if [[ -f "${FAKE_SERVE_STATE}" ]]; then
    cat "${FAKE_SERVE_AFTER_JSON}"
  else
    cat "${FAKE_SERVE_BEFORE_JSON}"
  fi
  exit 0
fi

if [[ "$#" -eq 4 && "$1" == "serve" && "$2" == "--bg" && "$3" == "--https=8443" && "$4" == "http://127.0.0.1:8141" ]]; then
  printf '%s\n' "serve apply" >>"${FAKE_CALL_LOG}"
  : >"${FAKE_SERVE_STATE}"
  exit 0
fi

if [[ "$#" -eq 3 && "$1" == "serve" && "$2" == "--https=8443" && "$3" == "off" ]]; then
  printf '%s\n' "serve rollback" >>"${FAKE_CALL_LOG}"
  rm -f "${FAKE_SERVE_STATE}"
  exit 0
fi

printf 'Unexpected tailscale invocation: %s\n' "$*" >&2
exit 64
SCRIPT

  cat >"${ERROR_HUB_CURL_BIN}" <<'SCRIPT'
#!/usr/bin/env bash
set -euo pipefail
printf 'curl %s\n' "$*" >>"${FAKE_CALL_LOG}"
exit "${FAKE_CURL_EXIT_STATUS}"
SCRIPT

  chmod +x "${ERROR_HUB_SUDO_BIN}" "${ERROR_HUB_TAILSCALE_BIN}" "${ERROR_HUB_CURL_BIN}"
}

teardown() {
  rm -rf "${fixture_directory}"
}

write_exact_serve_mapping() {
  local destination="$1"
  printf '%s\n' '{"TCP":{"8443":{"HTTPS":true}},"Web":{"unit-test-node.example.ts.net:8443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:8141"}}}}}' >"${destination}"
}

run_tailscale_setup() {
  run "${repository_root}/deploy/home-dev/configure-tailscale.sh"
}

@test "Tailscale Serve derives the private origin from Self.DNSName" {
  run_tailscale_setup

  [ "${status}" -eq 0 ]
  [[ "${output}" == *"https://unit-test-node.example.ts.net:8443"* ]]
  grep -Fx "serve apply" "${FAKE_CALL_LOG}"
  grep -F "https://unit-test-node.example.ts.net:8443/health/ready" "${FAKE_CALL_LOG}"
}

@test "configured private origin must match the current Tailscale peer" {
  export ERROR_HUB_PRIVATE_ORIGIN="https://different-node.example.ts.net:8443"

  run_tailscale_setup

  [ "${status}" -ne 0 ]
  [[ "${output}" == *"does not match"* ]]
  ! grep -Fq "serve apply" "${FAKE_CALL_LOG}"
}

@test "structurally invalid Serve JSON is rejected and the new mapping is rolled back" {
  printf '%s\n' '{"TCP":{"8443":{"HTTPS":true}},"Web":{"different-node.example.ts.net:8443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:8141"}}}}}' >"${FAKE_SERVE_AFTER_JSON}"

  run_tailscale_setup

  [ "${status}" -ne 0 ]
  [[ "${output}" == *"required private proxy"* ]]
  grep -Fx "serve apply" "${FAKE_CALL_LOG}"
  grep -Fx "serve rollback" "${FAKE_CALL_LOG}"
}

@test "a failed readiness probe rolls back a newly created Serve mapping" {
  export FAKE_CURL_EXIT_STATUS=22

  run_tailscale_setup

  [ "${status}" -ne 0 ]
  grep -Fx "serve apply" "${FAKE_CALL_LOG}"
  grep -Fx "serve rollback" "${FAKE_CALL_LOG}"
}

@test "an existing conflicting port 8443 mapping is never overwritten" {
  printf '%s\n' '{"TCP":{"8443":{"HTTPS":true}},"Web":{"unit-test-node.example.ts.net:8443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:9999"}}}}}' >"${FAKE_SERVE_BEFORE_JSON}"

  run_tailscale_setup

  [ "${status}" -ne 0 ]
  [[ "${output}" == *"already has a conflicting mapping"* ]]
  ! grep -Fq "serve apply" "${FAKE_CALL_LOG}"
  ! grep -Fq "serve rollback" "${FAKE_CALL_LOG}"
}

@test "an existing exact mapping is verified without being recreated" {
  write_exact_serve_mapping "${FAKE_SERVE_BEFORE_JSON}"

  run_tailscale_setup

  [ "${status}" -eq 0 ]
  ! grep -Fq "serve apply" "${FAKE_CALL_LOG}"
  ! grep -Fq "serve rollback" "${FAKE_CALL_LOG}"
  grep -F "https://unit-test-node.example.ts.net:8443/health/ready" "${FAKE_CALL_LOG}"
}

@test "Caddy validates and enforces the complete public route matrix" {
  run "${repository_root}/deploy/home-dev/test/verify-caddy-routes.sh"

  [ "${status}" -eq 0 ]
}

#!/usr/bin/env bats

setup() {
  repository_root="$(cd "${BATS_TEST_DIRNAME}/../../.." && pwd)"
}

@test "public host exposes only numeric Sentry envelope writes and liveness" {
  public_fragment="${repository_root}/deploy/home-dev/caddy-error-hub.caddy"

  run grep -F "errors.intexuraos.cloud:80" "${public_fragment}"
  [ "${status}" -eq 0 ]
  run grep -F "method POST OPTIONS" "${public_fragment}"
  [ "${status}" -eq 0 ]
  run grep -F "^/api/[0-9]+/envelope/$" "${public_fragment}"
  [ "${status}" -eq 0 ]
  run grep -F "method GET" "${public_fragment}"
  [ "${status}" -eq 0 ]
  run grep -F "path /health/live" "${public_fragment}"
  [ "${status}" -eq 0 ]
  run grep -F "reverse_proxy 127.0.0.1:8140" "${public_fragment}"
  [ "${status}" -eq 0 ]
  run grep -F 'respond "not found" 404' "${public_fragment}"
  [ "${status}" -eq 0 ]

  run grep -E "8141|/api/issues|/api/events|/api/exports|/metrics|/health/ready" "${public_fragment}"
  [ "${status}" -eq 1 ]
}

@test "deployment host exposes only the bounded workflow-run POST" {
  deploy_fragment="${repository_root}/deploy/home-dev/caddy-error-hub-deploy.caddy"

  run grep -F "errors-deploy.intexuraos.cloud:80" "${deploy_fragment}"
  [ "${status}" -eq 0 ]
  run grep -F "method POST" "${deploy_fragment}"
  [ "${status}" -eq 0 ]
  run grep -F "path /github/workflow-run" "${deploy_fragment}"
  [ "${status}" -eq 0 ]
  run grep -F "max_size 1MB" "${deploy_fragment}"
  [ "${status}" -eq 0 ]
  run grep -F "reverse_proxy 127.0.0.1:9003" "${deploy_fragment}"
  [ "${status}" -eq 0 ]
  run grep -F 'respond "not found" 404' "${deploy_fragment}"
  [ "${status}" -eq 0 ]

  run grep -E "8140|8141|/health|/api/" "${deploy_fragment}"
  [ "${status}" -eq 1 ]
}

@test "Tailscale setup uses the private loopback listener on dedicated HTTPS port 8443" {
  script="${repository_root}/deploy/home-dev/configure-tailscale.sh"

  run grep -F -- "serve --bg --https=8443 http://127.0.0.1:8141" "${script}"
  [ "${status}" -eq 0 ]
  run grep -F -- "serve status --json" "${script}"
  [ "${status}" -eq 0 ]
  run grep -F -- "https://home-dev.taild6ad57.ts.net:8443/health/ready" "${script}"
  [ "${status}" -eq 0 ]

  run grep -E -- "--https=(443|8140|8141)" "${script}"
  [ "${status}" -eq 1 ]
}

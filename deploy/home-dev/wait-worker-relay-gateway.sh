#!/usr/bin/env bash
set -euo pipefail

for ((attempt = 0; attempt < 40; attempt++)); do
  if /usr/sbin/ip -6 -o address show dev code-worker-br up \
    scope global to fd00:172:28::1/128 -tentative -dadfailed 2>/dev/null \
    | grep -Eq 'inet6 fd00:172:28::1/64([[:space:]]|$)'; then
    exit 0
  fi
  sleep 0.25
done

printf 'The worker bridge IPv6 gateway did not become ready.\n' >&2
exit 1

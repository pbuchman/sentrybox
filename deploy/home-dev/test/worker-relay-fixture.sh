#!/usr/bin/env bash
set -euo pipefail

readonly socket=sentrybox-worker-relay.socket
readonly proxy=sentrybox-worker-relay.service
readonly firewall=intexuraos-iptables.service
readonly bridge=code-worker-br
readonly gateway=fd00:172:28::1
readonly hostname=relay-fixture.example.ts.net
readonly certificate=/fixture/test.crt
readonly key=/fixture/test.key

[[ "$EUID" == 0 && -f /fixture/isolated-test-container ]]
[[ "${1:-}" == prepare || -f /.dockerenv ]]

prepare() {
  install -d -m 0700 /etc/sentrybox
  printf 'SENTRYBOX_WORKER_RELAY_TARGET=%s:8443\n' "${hostname}" >/etc/sentrybox/worker-relay.env
  chmod 0600 /etc/sentrybox/worker-relay.env
  cat >/etc/systemd/system/relay-fixture-bridge.service <<'UNIT'
[Unit]
Description=Create the isolated relay test bridge
After=basic.target systemd-udevd.service
Requires=systemd-udevd.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/fixture/worker-relay-fixture.sh bridge-up
ExecStop=/fixture/worker-relay-fixture.sh bridge-down
UNIT
  cat >/etc/systemd/system/intexuraos-iptables.service <<'UNIT'
[Unit]
Description=Represent the worker firewall lifecycle
Requires=relay-fixture-bridge.service
After=relay-fixture-bridge.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/bin/true
ExecStop=/fixture/worker-relay-fixture.sh firewall-down
UNIT
  systemctl enable "${socket}"
  systemctl mask systemd-binfmt.service systemd-sysctl.service systemd-pstore.service \
    apt-daily.timer apt-daily-upgrade.timer
}

add_bridge() {
  ip link add "${bridge}" type bridge
  ip link set "${bridge}" up
  ip -6 address add "${gateway}/64" dev "${bridge}" nodad
  ip -6 address add fd00:172:28::3/64 dev "${bridge}" nodad
  ip address add 172.28.0.1/16 dev "${bridge}"
  ip link set relay-worker0 master "${bridge}"
  udevadm trigger --settle --action=add "/sys/class/net/${bridge}"
}

bridge_up() {
  ip netns add relay-worker
  ip link add relay-worker0 type veth peer name worker0 netns relay-worker
  ip link set relay-worker0 up
  ip -n relay-worker link set worker0 up
  ip -n relay-worker -6 address add fd00:172:28::2/64 dev worker0 nodad
  ip -n relay-worker address add 172.28.0.2/16 dev worker0
  add_bridge
}

assert_stopped() {
  if systemctl is-active --quiet "${socket}" "${proxy}"; then
    return 1
  fi
  [[ -z "$(ss -H -6 -ltn 'sport = :8443')" ]]
}

firewall_down() {
  # The real socket and proxy have to stop before the firewall can be removed.
  assert_stopped
  if [[ -f /fixture/expect-shutdown ]]; then
    touch /fixture/shutdown-verified
  fi
}

wait_until() {
  for ((attempt = 0; attempt < 100; attempt++)); do
    if "$@"; then
      return 0
    fi
    sleep 0.1
  done
  printf 'Timed out waiting for %s\n' "$*" >&2
  return 1
}

request() {
  local namespace="$1" name="$2" endpoint="$3"
  ip netns exec "${namespace}" curl --noproxy '*' --silent --show-error --fail \
    --connect-timeout 2 --max-time 4 --cacert "${certificate}" \
    --connect-to "${name}:8443:${endpoint}:8443" "https://${name}:8443/"
}

assert_rejected() {
  local code=0
  request "$@" >/dev/null 2>&1 || code=$?
  [[ "${code}" == 7 || "${code}" == 28 ]]
}

hold_connection() {
  rm -f /fixture/tls-connected
  ip netns exec relay-worker python3 - "${gateway}" "${hostname}" "${certificate}" >/fixture/tls-client.log 2>&1 <<'PYTHON' &
import pathlib
import socket
import ssl
import sys

address, name, certificate = sys.argv[1:]
context = ssl.create_default_context(cafile=certificate)
with socket.create_connection((address, 8443), timeout=15) as tcp:
    with context.wrap_socket(tcp, server_hostname=name) as tls:
        pathlib.Path("/fixture/tls-connected").touch()
        try:
            assert tls.recv(1) == b"", "proxy delivered data after shutdown"
        except ConnectionResetError:
            pass
PYTHON
  client_pid=$!
  wait_until test -f /fixture/tls-connected
  proxy_pid="$(systemctl show "${proxy}" --property=MainPID --value)"
  [[ "${proxy_pid}" =~ ^[1-9][0-9]*$ ]]
}

verify() {
  systemd --version | sed -n '1p' | grep -E '^systemd 255 '
  wait_until systemctl is-active --quiet relay-fixture-bridge.service
  local bridge_device
  bridge_device="$(systemd-escape --path --suffix=device "/sys/subsystem/net/devices/${bridge}")"
  if ! systemctl is-active --quiet "${bridge_device}"; then
    # Some container kernels miss the initial udev event. Re-read the real
    # udev database while systemd still has its original boot jobs queued.
    systemctl daemon-reexec
  fi
  wait_until systemctl is-active --quiet multi-user.target
  systemctl is-active "${firewall}"
  systemctl is-active "${socket}"
  systemd-analyze verify multi-user.target "${socket}" "${proxy}"
  local firewall_started socket_started boot_ready code=0
  firewall_started="$(systemctl show "${firewall}" -p ActiveEnterTimestampMonotonic --value)"
  socket_started="$(systemctl show "${socket}" -p ActiveEnterTimestampMonotonic --value)"
  boot_ready="$(systemctl show multi-user.target -p ActiveEnterTimestampMonotonic --value)"
  ((firewall_started > 0 && firewall_started <= socket_started && socket_started <= boot_ready))
  if systemctl is-active --quiet "${proxy}"; then
    printf 'The proxy started before receiving a connection.\n' >&2
    return 1
  fi

  openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/CN=${hostname}" \
    -addext "subjectAltName=DNS:${hostname}" -keyout "${key}" -out "${certificate}" >/dev/null 2>&1
  openssl s_server -quiet -www -accept 127.0.0.2:8443 -cert "${certificate}" -key "${key}" \
    >/fixture/tls-server.log 2>&1 &
  wait_until upstream_listening
  request relay-worker "${hostname}" "[${gateway}]" >/dev/null
  request relay-worker wrong.example.ts.net "[${gateway}]" >/dev/null 2>&1 || code=$?
  [[ "${code}" == 60 ]]
  assert_rejected relay-worker "${hostname}" '[fd00:172:28::3]'
  assert_rejected relay-worker "${hostname}" 172.28.0.1

  ip netns add relay-outsider
  ip link add relay-other0 type veth peer name outsider0 netns relay-outsider
  ip link set relay-other0 up
  ip -6 address add fd00:172:29::1/64 dev relay-other0 nodad
  ip -n relay-outsider link set outsider0 up
  ip -n relay-outsider -6 address add fd00:172:29::2/64 dev outsider0 nodad
  ip -n relay-outsider -6 route add "${gateway}/128" via fd00:172:29::1 dev outsider0
  assert_rejected relay-outsider "${hostname}" "[${gateway}]"
  printf 'Verified TLS hostname checks and exact device/address listeners.\n'

  hold_connection
  grep -Eq '^Uid:[[:space:]]+[1-9]' "/proc/${proxy_pid}/status"
  grep -Eq '^NoNewPrivs:[[:space:]]+1$' "/proc/${proxy_pid}/status"
  grep -Eq '^CapEff:[[:space:]]+0+$' "/proc/${proxy_pid}/status"
  systemctl stop "${firewall}"
  assert_stopped
  assert_proxy_exited
  if ! wait "${client_pid}"; then
    cat /fixture/tls-client.log >&2
    return 1
  fi
  systemctl start "${firewall}"
  wait_until systemctl is-active --quiet "${socket}"
  request relay-worker "${hostname}" "[${gateway}]" >/dev/null
  printf 'Verified firewall stop closes accepted TLS and firewall start rearms.\n'

  hold_connection
  ip link delete "${bridge}"
  wait_until assert_stopped
  assert_proxy_exited
  kill "${client_pid}" 2>/dev/null || true
  wait "${client_pid}" || true
  systemctl is-active "${firewall}"
  add_bridge
  wait_until systemctl is-active --quiet "${socket}"
  request relay-worker "${hostname}" "[${gateway}]" >/dev/null
  printf 'Verified bridge removal stops the proxy and bridge return rearms.\n'

  systemctl stop "${socket}"
  ip -6 address del "${gateway}/64" dev "${bridge}"
  ip -6 address add "${gateway}/128" dev "${bridge}" nodad
  if systemctl start "${socket}" >/dev/null 2>&1; then
    printf 'The socket accepted a gateway with the wrong prefix.\n' >&2
    return 1
  fi
  [[ "$(systemctl show "${socket}" --property=Result --value)" == exit-code ]]
  assert_stopped
  ip -6 address del "${gateway}/128" dev "${bridge}"
  ip -6 address add "${gateway}/64" dev "${bridge}" nodad
  systemctl start "${socket}"
  printf 'Verified the gateway readiness check fails closed on the wrong prefix.\n'
  hold_connection
  touch /fixture/expect-shutdown
}

upstream_listening() {
  ss -H -4 -ltn 'sport = :8443' | grep -q '127.0.0.2:8443'
}

assert_proxy_exited() {
  if kill -0 "${proxy_pid}" 2>/dev/null; then
    printf 'The original proxy process is still running.\n' >&2
    return 1
  fi
}

case "${1:-}" in
  prepare) prepare ;;
  bridge-up) bridge_up ;;
  bridge-down)
    if ip link show "${bridge}" >/dev/null 2>&1; then
      ip link delete "${bridge}"
    fi
    ip netns delete relay-worker
    ;;
  firewall-down) firewall_down ;;
  verify) verify ;;
  *) exit 2 ;;
esac

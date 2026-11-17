#!/bin/sh
set -eu
# Clean up an interface left behind if the helper was killed while Gateway lived.
if ip link show wg0 >/dev/null 2>&1; then
    wg-quick down /etc/wireguard/wg0.conf
fi
wg-quick up /etc/wireguard/wg0.conf
peer_pid=''
if [ -n "${ENROLLMENT_REQUEST_DIR:-}" ] && [ -n "${ENROLLMENT_ACK_DIR:-}" ]; then
    /usr/local/bin/zt-peer-helper &
    peer_pid=$!
fi
stop() {
    [ -z "$peer_pid" ] || kill "$peer_pid" 2>/dev/null || true
    wg-quick down /etc/wireguard/wg0.conf
    exit 0
}
trap stop TERM INT
while :; do sleep 3600 & wait $!; done

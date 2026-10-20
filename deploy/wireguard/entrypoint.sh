#!/bin/sh
set -eu
# Clean up an interface left behind if the helper was killed while Gateway lived.
if ip link show wg0 >/dev/null 2>&1; then
    wg-quick down /etc/wireguard/wg0.conf
fi
wg-quick up /etc/wireguard/wg0.conf
trap 'wg-quick down /etc/wireguard/wg0.conf; exit 0' TERM INT
while :; do sleep 3600 & wait $!; done

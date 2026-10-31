#!/bin/sh
set -eu
# Only this project's WireGuard interface enters these chains.
action=${1:?up or down}
interface=${2:?WireGuard interface}
api_port=${3:?API port}
gateway_ip=${4:-}
case "$interface" in ztgw0) ;; *) echo 'Unexpected WireGuard interface' >&2; exit 1 ;; esac
case "$api_port" in ''|*[!0-9]*) echo 'Invalid API port' >&2; exit 1 ;; esac
ipt() { iptables -w 5 "$@"; }
case "$action" in
  up)
    if [ -z "$gateway_ip" ]; then
      gateway_ip=$(ip -j -4 addr show dev "$interface" | python3 -c '
import ipaddress,json,sys
addresses=[str(ipaddress.IPv4Address(a["local"])) for item in json.load(sys.stdin) for a in item.get("addr_info",[]) if a.get("family")=="inet"]
if len(addresses)!=1: raise SystemExit("Expected exactly one Gateway IPv4 address")
print(addresses[0])')
    fi
    python3 -c 'import ipaddress,sys; ipaddress.IPv4Address(sys.argv[1])' "$gateway_ip"
    if ipt -S ZTNATIVE_IN >/dev/null 2>&1 || ipt -S ZTNATIVE_FW >/dev/null 2>&1 || ipt -t mangle -S ZTNATIVE_PRE >/dev/null 2>&1; then
      echo 'Project firewall chain already exists; inspect it instead of overwriting.' >&2
      exit 1
    fi
    # Mangle PREROUTING runs after conntrack and before INPUT/FORWARD.
    # This protects the host even if another service inserts an earlier filter ACCEPT.
    ipt -t mangle -N ZTNATIVE_PRE
    ipt -t mangle -A ZTNATIVE_PRE -m addrtype ! --dst-type LOCAL -j DROP
    ipt -t mangle -A ZTNATIVE_PRE -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
    ipt -t mangle -A ZTNATIVE_PRE -d "$gateway_ip" -p tcp --dport "$api_port" -j ACCEPT
    ipt -t mangle -A ZTNATIVE_PRE -j DROP
    ipt -N ZTNATIVE_IN
    ipt -N ZTNATIVE_FW
    ipt -A ZTNATIVE_IN -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
    ipt -A ZTNATIVE_IN -d "$gateway_ip" -p tcp --dport "$api_port" -j ACCEPT
    ipt -A ZTNATIVE_IN -j DROP
    ipt -A ZTNATIVE_FW -j DROP
    ipt -I INPUT 1 -i "$interface" -j ZTNATIVE_IN
    ipt -I FORWARD 1 -i "$interface" -j ZTNATIVE_FW
    ipt -t mangle -I PREROUTING 1 -i "$interface" -j ZTNATIVE_PRE
    ;;
  down)
    if ipt -C INPUT -i "$interface" -j ZTNATIVE_IN >/dev/null 2>&1; then
      ipt -D INPUT -i "$interface" -j ZTNATIVE_IN
    fi
    if ipt -C FORWARD -i "$interface" -j ZTNATIVE_FW >/dev/null 2>&1; then
      ipt -D FORWARD -i "$interface" -j ZTNATIVE_FW
    fi
    if ipt -t mangle -C PREROUTING -i "$interface" -j ZTNATIVE_PRE >/dev/null 2>&1; then
      ipt -t mangle -D PREROUTING -i "$interface" -j ZTNATIVE_PRE
    fi
    for chain in ZTNATIVE_IN ZTNATIVE_FW; do
      if ipt -S "$chain" >/dev/null 2>&1; then
        ipt -F "$chain"
        ipt -X "$chain"
      fi
    done
    if ipt -t mangle -S ZTNATIVE_PRE >/dev/null 2>&1; then
      ipt -t mangle -F ZTNATIVE_PRE
      ipt -t mangle -X ZTNATIVE_PRE
    fi
    ;;
  *) echo 'Expected up or down' >&2; exit 1 ;;
esac

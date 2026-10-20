#!/bin/sh
set -eu
wg-quick up /etc/wireguard/wg0.conf
# Policy is confined to this demo worker's network namespace, never the host.
iptables -A INPUT -i lo -j ACCEPT
iptables -A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -A INPUT -i wg0 -s 10.100.0.1 -p tcp --dport 22 -j ACCEPT
iptables -P INPUT DROP
iptables -P FORWARD DROP
iptables -A OUTPUT -o lo -j ACCEPT
iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -A OUTPUT -o wg0 -d 10.100.0.1 -p tcp --dport 3000 -j ACCEPT
iptables -A OUTPUT -p udp --dport 51820 -j ACCEPT
iptables -P OUTPUT DROP
cp /run/zt/authorized_keys /etc/ssh/authorized_keys/ztuser
chmod 644 /etc/ssh/authorized_keys/ztuser
/usr/sbin/sshd -t
/usr/sbin/sshd -D -e &
ssh_pid=$!
su-exec ztuser:ztgroup /usr/local/bin/zt-agent &
agent_pid=$!
trap 'kill "$ssh_pid" "$agent_pid" 2>/dev/null || true; wait; exit 0' TERM INT
# Fail the fixture if SSH or telemetry exits, so Compose can restart it.
while kill -0 "$ssh_pid" 2>/dev/null && kill -0 "$agent_pid" 2>/dev/null; do
    sleep 2 & wait $!
done
kill "$ssh_pid" "$agent_pid" 2>/dev/null || true
exit 1

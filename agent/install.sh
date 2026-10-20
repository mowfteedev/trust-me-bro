#!/usr/bin/env bash
# Build/install the Linux Mini-Agent; existing identity/token configuration is kept.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[[ "$(uname -s)" == Linux ]] || { echo 'Mini-Agent requires Linux.' >&2; exit 1; }

build_binary() {
    command -v go >/dev/null 2>&1 || {
        echo 'Go 1.23+ is needed to build. Alternatively provide ZT_AGENT_BINARY from a trusted local build.' >&2
        exit 1
    }
    (cd "${SCRIPT_DIR}" && CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o "$1" .)
}

# Exercise the exact installer build without root, systemd or changes to the host.
if [[ "${1:-}" == --build-only && "$#" -eq 2 ]]; then
    [[ "$2" == /* ]] || { echo '--build-only needs an absolute output path.' >&2; exit 1; }
    build_binary "$2"
    echo "Built Mini-Agent: $2"
    exit 0
elif [[ "$#" -ne 0 ]]; then
    echo 'Usage: install.sh [--build-only /absolute/output/path]' >&2
    exit 1
fi

[[ "${EUID}" -eq 0 ]] || { echo 'Run installation with sudo (or use --build-only).' >&2; exit 1; }
command -v systemctl >/dev/null 2>&1 && systemctl show-environment >/dev/null 2>&1 || {
    echo 'Installation requires a running systemd on the Linux worker; use Docker for the container demo.' >&2
    exit 1
}

INSTALL_DIR=/opt/zt-serverops/agent
ENV_TARGET="${INSTALL_DIR}/.env"
# Reject symlinks before privileged writes. Never rotate an existing node token.
[[ ! -L "${INSTALL_DIR}" && ! -L "${ENV_TARGET}" ]] || { echo 'Refusing symlink installation/configuration path.' >&2; exit 1; }
if [[ ! -f "${ENV_TARGET}" ]]; then
    [[ -n "${NODE_TOKEN:-}" ]] || { echo 'NODE_TOKEN is required for a new installation.' >&2; exit 1; }
    for value in "${NODE_TOKEN}" "${NODE_ID:-$(hostname)}" "${GATEWAY_URL:-http://10.100.0.1:3000}" "${NETWORK_INTERFACE:-wg0}" "${DISK_MOUNT_POINT:-/}"; do
        [[ "$value" != *[$'\r\n\t '\\'"']* ]] || { echo 'New environment values must not contain whitespace, quotes or backslashes.' >&2; exit 1; }
    done
fi

BUILD_DIR="$(mktemp -d)"
trap 'rm -rf "${BUILD_DIR}"' EXIT
if [[ -n "${ZT_AGENT_BINARY:-}" ]]; then
    [[ -f "${ZT_AGENT_BINARY}" && -x "${ZT_AGENT_BINARY}" ]] || { echo 'ZT_AGENT_BINARY must point to a trusted executable Linux Mini-Agent.' >&2; exit 1; }
    install -m 0755 "${ZT_AGENT_BINARY}" "${BUILD_DIR}/zt-agent"
else
    build_binary "${BUILD_DIR}/zt-agent"
fi

# Validation has no network or collector side effects when NODE_TOKEN is absent.
# Catch wrong architecture/missing libraries before replacing a working binary.
if NODE_TOKEN= "${BUILD_DIR}/zt-agent" >"${BUILD_DIR}/validation.txt" 2>&1; then
    echo 'Unexpected executable; refusing installation.' >&2
    exit 1
fi
if ! grep -q 'NODE_TOKEN is required' "${BUILD_DIR}/validation.txt"; then
    echo 'Binary startup validation failed; verify architecture and build.' >&2
    exit 1
fi

if ! id -u zt-agent >/dev/null 2>&1; then
    useradd --system --user-group --no-create-home --shell /usr/sbin/nologin zt-agent
fi
install -d -m 0755 -o root -g root "${INSTALL_DIR}"
if [[ ! -f "${ENV_TARGET}" ]]; then
    umask 077
    cat >"${ENV_TARGET}" <<ENV
GATEWAY_URL=${GATEWAY_URL:-http://10.100.0.1:3000}
NODE_ID=${NODE_ID:-$(hostname)}
NODE_TOKEN=${NODE_TOKEN}
NETWORK_INTERFACE=${NETWORK_INTERFACE:-wg0}
DISK_MOUNT_POINT=${DISK_MOUNT_POINT:-/}
BEACON_INTERVAL_SECONDS=3.0
MAX_BACKOFF_SECONDS=30.0
JITTER_RATIO=0.1
HTTP_TIMEOUT_SECONDS=3.0
GOMAXPROCS=1
ENV
fi
chown root:root "${ENV_TARGET}"
chmod 0600 "${ENV_TARGET}"
install -m 0755 -o root -g root "${BUILD_DIR}/zt-agent" "${INSTALL_DIR}/zt-agent.new"
mv -f "${INSTALL_DIR}/zt-agent.new" "${INSTALL_DIR}/zt-agent"

cat >/etc/systemd/system/zt-agent.service <<UNIT
[Unit]
Description=ZT-ServerOps Linux Mini-Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=zt-agent
Group=zt-agent
WorkingDirectory=${INSTALL_DIR}
Environment=GOMAXPROCS=1
EnvironmentFile=${ENV_TARGET}
ExecStart=${INSTALL_DIR}/zt-agent
Restart=on-failure
RestartSec=3s
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable zt-agent.service
systemctl restart zt-agent.service
systemctl is-active --quiet zt-agent.service
echo 'Mini-Agent installed; existing .env kept. Check journalctl -u zt-agent for beacon ACK and configuration/collection errors.'

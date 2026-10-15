#!/usr/bin/env bash
# Idempotent classroom bootstrap: no key rotation and no existing .env overwrite.
set -euo pipefail
umask 077
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
KEYS_DIR="${PROJECT_ROOT}/keys"
ENV_FILE="${PROJECT_ROOT}/.env"
WG_ENDPOINT="gateway:51820"
while (($#)); do
    case "$1" in
        --env-file) ENV_FILE="${2:?Missing env path}"; shift 2 ;;
        --endpoint) WG_ENDPOINT="${2:?Missing gateway endpoint}"; shift 2 ;;
        *) echo "Usage: $0 [--env-file PATH] [--endpoint HOST:51820]" >&2; exit 2 ;;
    esac
done
command -v python3 >/dev/null || { echo 'Install python3 first.' >&2; exit 1; }
command -v openssl >/dev/null || { echo 'Install openssl first.' >&2; exit 1; }
command -v ssh-keygen >/dev/null || { echo 'Install openssh client first (ssh-keygen).' >&2; exit 1; }
mkdir -p "$KEYS_DIR"
chmod 700 "$KEYS_DIR"
for key_name in bastion_id_ed25519 worker_ssh_host_ed25519; do
    key_path="$KEYS_DIR/$key_name"
    if [[ ! -e "$key_path" ]]; then
        ssh-keygen -q -t ed25519 -N '' -C "zt-$key_name" -f "$key_path"
    fi
    # Require an OpenSSH Ed25519 key; PEM fallback is not an SSH authorized key.
    ssh-keygen -y -f "$key_path" > "$key_path.pub"
    [[ "$(cut -d ' ' -f 1 "$key_path.pub")" == "ssh-ed25519" ]] || { echo "Expected SSH Ed25519: $key_path" >&2; exit 1; }
    chmod 400 "$key_path"
    chmod 644 "$key_path.pub"
done
for peer in gateway node_01; do
    private_path="$KEYS_DIR/wireguard_${peer}_private.key"
    public_path="$KEYS_DIR/wireguard_${peer}_public.key"
    if [[ ! -e "$private_path" ]]; then
        if command -v wg >/dev/null; then
            wg genkey > "$private_path"
            wg pubkey < "$private_path" > "$public_path"
        else
            # OpenSSL's X25519 PKCS8/SPKI DER end in the raw 32-byte keys.
            temp_path="$(mktemp "$KEYS_DIR/.x25519.XXXXXX")"
            trap 'rm -f "$temp_path"' EXIT
            openssl genpkey -algorithm X25519 -out "$temp_path"
            openssl pkey -in "$temp_path" -outform DER | tail -c 32 | base64 > "$private_path"
            openssl pkey -in "$temp_path" -pubout -outform DER | tail -c 32 | base64 > "$public_path"
            rm -f "$temp_path"
            trap - EXIT
        fi
    fi
    [[ -s "$public_path" ]] || { echo "Missing public key: $public_path" >&2; exit 1; }
    chmod 600 "$private_path"
    chmod 644 "$public_path"
done
if [[ ! -e "$KEYS_DIR/node_worker_01.token" ]]; then
    openssl rand -hex 32 > "$KEYS_DIR/node_worker_01.token"
fi
chmod 600 "$KEYS_DIR/node_worker_01.token"
# Render only missing configs. Existing configuration and peer keys are preserved.
for role in gateway node; do
    conf_path="$KEYS_DIR/wg0-$role.conf"
    if [[ ! -e "$conf_path" ]]; then
        python3 - "$PROJECT_ROOT" "$role" "$WG_ENDPOINT" <<'PY'
import pathlib, sys
root, role, endpoint = pathlib.Path(sys.argv[1]), sys.argv[2], sys.argv[3]
if any(c in endpoint for c in '\r\n'):
    raise SystemExit('Invalid WireGuard endpoint')
keys = root / 'keys'
text = (root / 'deploy/wireguard' / f'wg0-{role}.conf').read_text()
for placeholder, filename in {
    'GATEWAY_PRIVATE_KEY_PLACEHOLDER': 'wireguard_gateway_private.key',
    'NODE_PRIVATE_KEY_PLACEHOLDER': 'wireguard_node_01_private.key',
    'NODE_01_PUBLIC_KEY_PLACEHOLDER': 'wireguard_node_01_public.key',
    'GATEWAY_PUBLIC_KEY_PLACEHOLDER': 'wireguard_gateway_public.key',
}.items():
    text = text.replace(placeholder, (keys / filename).read_text().strip())
text = text.replace('gateway.example.com:51820', endpoint)
(keys / f'wg0-{role}.conf').write_text(text)
PY
    fi
    chmod 600 "$conf_path"
done
if [[ ! -e "$ENV_FILE" ]]; then
    python3 - "$PROJECT_ROOT" "$ENV_FILE" <<'PY'
import pathlib, secrets, sys
root, target = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
text = (root / '.env.example').read_text()
values = {
    'JWT_SECRET': secrets.token_hex(32),
    'POSTGRES_PASSWORD': secrets.token_hex(16),
    'TELEGRAM_PAIR_OTP': f'{secrets.randbelow(1000000):06d}',
    'NODE_TOKEN_01': (root / 'keys/node_worker_01.token').read_text().strip(),
}
values['MIGRATION_DATABASE_URL'] = f"postgres://zt_admin:{values['POSTGRES_PASSWORD']}@postgres:5432/zt_serverops"
values['DATABASE_URL'] = f'postgres://zt_app:{secrets.token_hex(16)}@postgres:5432/zt_serverops'
values['MAINTENANCE_DATABASE_URL'] = f'postgres://zt_maintenance:{secrets.token_hex(16)}@postgres:5432/zt_serverops'
target.write_text('\n'.join(f'{line.split("=", 1)[0]}={values[line.split("=", 1)[0]]}'
    if '=' in line and line.split('=', 1)[0] in values else line
    for line in text.splitlines()) + '\n')
PY
    chmod 600 "$ENV_FILE"
    echo "Created env: $ENV_FILE"
else
    echo "Preserved existing env: $ENV_FILE"
fi
echo 'Keys and WireGuard demo configs ready in keys/. Private SSH keys: chmod 400.'

#!/usr/bin/env python3
"""Read-only offline Worker bundle checks; never prints keys/tokens or sends traffic."""
import argparse
import base64
import configparser
import ipaddress
import json
from pathlib import Path
import re
import subprocess


def private(path):
    if path.is_symlink() or not path.is_file() or path.stat().st_mode & 0o077:
        raise ValueError('Bundle files must be regular private files (mode 0600).')
    return path.read_text(encoding='utf-8')


def key(value):
    if len(base64.b64decode(value, validate=True)) != 32:
        raise ValueError('WireGuard key length invalid.')


def check(bundle, worker_os, binary=None):
    if any(p.is_symlink() for p in [bundle.absolute(), *bundle.absolute().parents]) or not bundle.is_dir() or bundle.stat().st_mode & 0o077:
        raise ValueError('Bundle must be a private mode-0700 directory.')
    config = json.loads(private(bundle / 'agent-config.json'))
    metadata = json.loads(private(bundle / 'metadata.json'))
    if not isinstance(config, dict) or not isinstance(metadata, dict):
        raise ValueError('Configuration and metadata must be JSON objects.')
    token = private(bundle / 'node.token').strip()
    wireguard = configparser.ConfigParser(interpolation=None)
    wireguard.read_string(private(bundle / 'zt-worker.conf'))
    if len(token) < 48 or not re.fullmatch(r'[A-Za-z0-9_-]+', token) or config.get('NODE_TOKEN') != token:
        raise ValueError('Token is weak or differs between files.')
    if config.get('NODE_ID') != metadata.get('node_name'):
        raise ValueError('Node identity differs between config and metadata.')
    if not re.fullmatch(r'[a-zA-Z0-9_-]{3,64}', metadata.get('node_name', '')):
        raise ValueError('Invalid node name.')
    if metadata.get('node_type') not in ('VM', 'BARE_METAL'):
        raise ValueError('Unsupported Worker type.')
    address = ipaddress.ip_interface(wireguard['Interface']['Address'])
    if str(address.ip) != metadata.get('node_ip') or address.network.prefixlen != 32:
        raise ValueError('Overlay identity differs from metadata.')
    if address.ip not in ipaddress.ip_network('10.100.0.0/24') or str(address.ip) in ('10.100.0.0', '10.100.0.1', '10.100.0.2', '10.100.0.255'):
        raise ValueError('Address is outside the allocatable additional Worker range.')
    if config.get('GATEWAY_URL') != 'http://10.100.0.1:3000':
        raise ValueError('EC2 bundle requires overlay API3000; do not mix native API3100.')
    if config.get('NETWORK_INTERFACE') != metadata.get('tunnel_name'):
        raise ValueError('Interface differs between config and metadata.')
    if config.get('DISK_MOUNT_POINT') != ('/' if worker_os == 'linux' else 'C:\\'):
        raise ValueError('Disk collector mount does not match the selected OS.')
    if wireguard['Peer']['AllowedIPs'] != '10.100.0.1/32':
        raise ValueError('Worker must route only the Gateway /32.')
    if wireguard['Peer']['Endpoint'] != metadata.get('gateway_endpoint'):
        raise ValueError('Endpoint differs from metadata.')
    bastion = private(bundle / 'bastion_id_ed25519.pub').strip().split()
    expected = b'\x00\x00\x00\x0bssh-ed25519\x00\x00\x00\x20'
    if len(bastion) < 2 or bastion[0] != 'ssh-ed25519':
        raise ValueError('Bastion PUBLIC key invalid.')
    blob = base64.b64decode(bastion[1], validate=True)
    if len(blob) != len(expected) + 32 or not blob.startswith(expected):
        raise ValueError('Bastion PUBLIC key malformed.')
    key(wireguard['Interface']['PrivateKey'])
    key(wireguard['Peer']['PublicKey'])
    if binary:
        result = subprocess.run([str(binary.resolve()), '--validate-config', '--config', str(bundle / 'agent-config.json')], capture_output=True)
        if result.returncode:
            raise ValueError('Agent executable rejected config or architecture.')
    return {'evidence': 'offline_bundle_validation', 'config_consistent': True,
            'binary_config_validated': bool(binary), 'wireguard_handshake_verified': False,
            'ssh_host_pin_verified': False, 'firewall_verified': False, 'reboot_verified': False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bundle', type=Path, required=True)
    parser.add_argument('--worker-os', choices=['linux', 'windows'], required=True)
    parser.add_argument('--binary', type=Path, help='Trusted local native Agent executable; optional.')
    args = parser.parse_args()
    try:
        print(json.dumps(check(args.bundle, args.worker_os, args.binary)))
    except (OSError, ValueError, KeyError, configparser.Error):
        parser.exit(1, 'Worker bundle check failed: inspect identities, OS mount, API3000 and private permissions. No secrets printed.\n')


if __name__ == '__main__':
    main()

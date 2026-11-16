#!/usr/bin/env python3
"""Describe source and selected immutable image identities without env or keys."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parents[2]


def run(command):
    result = subprocess.run(command, cwd=ROOT, capture_output=True, text=True)
    if result.returncode:
        raise ValueError('Manifest command failed; no credentials or command output printed.')
    return result.stdout


def source_manifest():
    names = run(['git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0')
    files = {}
    for name in sorted(set(names)):
        path = ROOT / name
        if name and path.is_file() and not path.is_symlink():
            files[name] = hashlib.sha256(path.read_bytes()).hexdigest()
    digest = hashlib.sha256(json.dumps(files, sort_keys=True).encode()).hexdigest()
    return {
        'format_version': 1,
        'created_at': datetime.now(timezone.utc).isoformat(),
        'commit': run(['git', 'rev-parse', 'HEAD']).strip(),
        'branch': run(['git', 'branch', '--show-current']).strip(),
        'dirty': bool(run(['git', 'status', '--porcelain'])),
        'source_sha256': digest,
        'source_files': files,
        'migrations': {p.name: hashlib.sha256(p.read_bytes()).hexdigest()
                       for p in sorted((ROOT / 'gateway/migrations').glob('*.sql'))},
        'images': [],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--image', action='append', default=[], help='Image tag/ID to inspect; repeat per runtime image.')
    parser.add_argument('--output', type=Path)
    parser.add_argument('--require-clean', action='store_true')
    args = parser.parse_args()
    try:
        result = source_manifest()
        if args.require_clean and result['dirty']:
            raise ValueError('Commit the reviewed source before creating a clean release manifest.')
        for image in args.image:
            value = json.loads(run(['docker', 'image', 'inspect', '--', image]))[0]
            result['images'].append({'id': value['Id'], 'repo_digests': value.get('RepoDigests') or [],
                                     'tags': value.get('RepoTags') or [], 'size_bytes': value['Size']})
        rendered = json.dumps(result, ensure_ascii=False, indent=2) + '\n'
        if args.output:
            with args.output.open('x', encoding='utf-8') as stream:
                stream.write(rendered)
        else:
            print(rendered, end='')
    except (OSError, ValueError, KeyError):
        parser.exit(1, 'Cannot create manifest: source is not clean, image unavailable or output already exists.\n')


if __name__ == '__main__':
    main()

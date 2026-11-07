#!/usr/bin/env python3
"""Cụm đồ án riêng: không dùng .env hoặc volume DB của dự án cũ."""
import argparse
from pathlib import Path
import subprocess
import demo_actions


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['up', 'setup', 'doctor', 'check', 'check-cpu', 'check-telegram', 'maintenance', 'down', 'status', 'logs'])
    parser.add_argument('--env-file', type=Path, default=demo_actions.KEYS / 'demo.env')
    parser.add_argument('--project', default='zt_demo')
    parser.add_argument('--core-only', action='store_true', help='Start the Gateway core; the prepared Worker runs on another machine.')
    parser.add_argument('--no-build', action='store_true', help='Use prebuilt images, for example images loaded onto a small EC2 instance.')
    args = parser.parse_args()
    env_path = args.env_file.resolve()
    demo_actions.dispatch(args.action, env_path, args.project, parser.error,
                          start_worker=not args.core_only, build=not args.no_build)


if __name__ == '__main__':
    try:
        main()
    except (subprocess.CalledProcessError, RuntimeError) as error:
        raise SystemExit(str(error))

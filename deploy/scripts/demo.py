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
    args = parser.parse_args()
    env_path = args.env_file.resolve()
    demo_actions.dispatch(args.action, env_path, args.project, parser.error)


if __name__ == '__main__':
    try:
        main()
    except (subprocess.CalledProcessError, RuntimeError) as error:
        raise SystemExit(str(error))

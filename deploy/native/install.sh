#!/bin/sh
set -eu
kit_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec python3 -B "$kit_dir/scripts/install.py" "$@"

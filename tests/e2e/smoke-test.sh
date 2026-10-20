#!/usr/bin/env bash
# Run actual demo checks. Historical source-string tests are not runtime evidence.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${SCRIPT_DIR}/../.."
exec python3 deploy/scripts/demo.py check "$@"

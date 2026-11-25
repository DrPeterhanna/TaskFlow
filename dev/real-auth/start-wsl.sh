#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
if [ ! -x "$HOME/.local/share/taskflow-runtime-v1/bin/python" ]; then
  echo 'First run: double-click Setup-Backend.cmd first.' >&2
  exit 1
fi
exec "$HOME/.local/share/taskflow-runtime-v1/bin/python" launch.py

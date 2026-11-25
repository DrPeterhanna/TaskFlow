#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
if [ "$(uname -m)" != x86_64 ]; then echo 'This package requires an Intel/AMD x64 Windows PC.' >&2; exit 1; fi
python3 -c 'import sys; assert (3,10) <= sys.version_info[:2] <= (3,12), "Ubuntu Python 3.10-3.12 required"'
mkdir -p "$HOME/.local/share"
if ! python3 -m venv "$HOME/.local/share/taskflow-runtime-v1"; then
  echo 'Python venv missing. In Ubuntu run: sudo apt update && sudo apt install python3-venv' >&2
  exit 1
fi
"$HOME/.local/share/taskflow-runtime-v1/bin/python" -m pip install --no-index --find-links wheels -r requirements.txt
chmod +x bin/auth bin/postgrest
printf 'Setup complete. Close this window and double-click Start-Backend.cmd.\n'

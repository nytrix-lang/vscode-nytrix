#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PYTHON_BIN="${PYTHON_BIN:-}"
if [[ -z "$PYTHON_BIN" ]]; then
  if [[ -x /tmp/ny_gui_venv/bin/python ]]; then
    PYTHON_BIN=/tmp/ny_gui_venv/bin/python
  else
    PYTHON_BIN=python3
  fi
fi

exec "$PYTHON_BIN" "$SCRIPT_DIR/keysend.py" "$@"

#!/usr/bin/env bash
set -euo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

find_repo_root() {
  local current="$TEST_DIR"
  while [[ "$current" != "/" ]]; do
    if [[ -d "$current/tmp/projects/vscode-nytrix" && -d "$current/lib" ]]; then
      printf '%s\n' "$current"
      return 0
    fi
    current="$(dirname "$current")"
  done
  cd "$TEST_DIR/../../../.." && pwd
}

REPO_ROOT="${NYTRIX_REPO_ROOT:-$(find_repo_root)}"
EXT_ROOT="${NYTRIX_VSCODE_EXTENSION_ROOT:-$REPO_ROOT/tmp/projects/vscode-nytrix}"
export NYTRIX_VSCODE_EXTENSION_ROOT="$EXT_ROOT"

run_js_smoke() {
  node "$TEST_DIR/bootstrap_smoke.js"
  node "$TEST_DIR/code_actions_smoke.js"
  node "$TEST_DIR/debug_symbol_smoke.js"
}

usage() {
  cat <<EOF
Usage: $0 <target> [args...]

Targets:
  check                 npm syntax check for the extension
  js | unit             bootstrap + code action + debug symbol smokes
  lsp                  raw LSP JSON-RPC smoke
  dap                  stdio DAP smoke
  smoke                check + js + lsp + dap
  ui                   VS Code UI smoke
  clickthrough         focused UI clickthrough
  assist-ui            focused assist/code-action UI pass
  syntax-ui            focused grammar screenshot pass
  headless-ui          UI smoke on Xvfb
  headless-clickthrough clickthrough on Xvfb
  headless-syntax-ui   syntax UI pass on Xvfb
  xephyr               launch the raw sandbox helper
  full                 smoke + clickthrough
EOF
}

target="${1:-smoke}"
shift || true

case "$target" in
  check)
    (cd "$EXT_ROOT" && npm run check)
    ;;
  js | unit)
    run_js_smoke
    ;;
  bootstrap)
    node "$TEST_DIR/bootstrap_smoke.js"
    ;;
  code-actions)
    node "$TEST_DIR/code_actions_smoke.js"
    ;;
  debug-symbols)
    node "$TEST_DIR/debug_symbol_smoke.js"
    ;;
  lsp)
    "$TEST_DIR/lsp_smoke.py" "$@"
    ;;
  dap)
    "$TEST_DIR/dap_smoke.py" "$@"
    ;;
  smoke)
    "$0" check
    "$0" js
    "$0" lsp
    "$0" dap
    ;;
  ui)
    "$TEST_DIR/ui_smoke.py" --fresh-session "$@"
    ;;
  clickthrough)
    "$TEST_DIR/ui_smoke.py" --fresh-session --clickthrough --artifacts "$TEST_DIR/.artifacts-clickthrough" "$@"
    ;;
  assist-ui)
    "$TEST_DIR/ui_smoke.py" --fresh-session --assist-only --entry-file assist_test.ny --artifacts "$TEST_DIR/.artifacts-assist" "$@"
    ;;
  syntax-ui)
    "$TEST_DIR/ui_smoke.py" --fresh-session --syntax-only --entry-file syntax_test.ny --artifacts "$TEST_DIR/.artifacts-syntax" "$@"
    ;;
  headless-ui)
    NYTRIX_VSCODE_TEST_HEADLESS=1 "$TEST_DIR/ui_smoke.py" --fresh-session "$@"
    ;;
  headless-clickthrough)
    NYTRIX_VSCODE_TEST_HEADLESS=1 "$TEST_DIR/ui_smoke.py" --fresh-session --clickthrough --artifacts "$TEST_DIR/.artifacts-headless-clickthrough" "$@"
    ;;
  headless-syntax-ui)
    NYTRIX_VSCODE_TEST_HEADLESS=1 "$TEST_DIR/ui_smoke.py" --fresh-session --syntax-only --entry-file syntax_test.ny --artifacts "$TEST_DIR/.artifacts-headless-syntax" "$@"
    ;;
  xephyr)
    "$TEST_DIR/xephyr-smoke.sh" "$@"
    ;;
  full)
    "$0" smoke
    "$0" clickthrough "$@"
    ;;
  -h | --help | help)
    usage
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac

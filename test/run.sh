#!/usr/bin/env bash
set -euo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXT_ROOT="${NYTRIX_VSCODE_EXTENSION_ROOT:-$(cd "$TEST_DIR/.." && pwd)}"
REPO_ROOT="${NYTRIX_REPO_ROOT:-}"

find_repo_root() {
  local current
  if [[ -n "$REPO_ROOT" ]]; then printf '%s\n' "$REPO_ROOT"; return 0; fi
  current="$TEST_DIR"
  while [[ "$current" != "/" ]]; do
    if [[ -d "$current/lib" && ( -x "$current/make" || -d "$current/build/release" ) ]]; then
      printf '%s\n' "$current"; return 0
    fi
    current="$(dirname "$current")"
  done
  cd "$TEST_DIR/../../../.." && pwd
}

REPO_ROOT="$(find_repo_root)"
export NYTRIX_REPO_ROOT="$REPO_ROOT"
export NYTRIX_VSCODE_EXTENSION_ROOT="$EXT_ROOT"

usage() {
  cat <<EOF_USAGE
Usage: $0 [target] [args...]

Core:
  js | unit              compact JS extension smoke suite
  lsp                   raw language-server protocol smoke
  dap                   raw debug-adapter protocol smoke
  protocol              lsp + dap
  check                 npm run check
  validate              npm run validate
  smoke                 check + js + protocol

UI:
  ui                    visible VS Code UI smoke
  clickthrough          visible editor/menu flow
  assist-ui             focused assist/code-action UI pass
  syntax-ui             focused grammar screenshot pass
  headless-ui           UI smoke on Xvfb
  headless-clickthrough clickthrough on Xvfb
  headless-syntax-ui    syntax UI pass on Xvfb
  xephyr                launch raw sandbox helper

Bundles:
  all | full            smoke + clickthrough
  headless-all          smoke + headless-clickthrough
EOF_USAGE
}

npm_script() { (cd "$EXT_ROOT" && npm run "$1"); }
ui() { "$TEST_DIR/ui_smoke.py" "$@"; }
protocol() { "$TEST_DIR/protocol_smoke.py" "$@"; }

run_target() {
  local target="${1:-smoke}"; shift || true
  case "$target" in
    check) npm_script check ;;
    validate) npm_script validate ;;
    js|unit) node "$TEST_DIR/js_smoke.js" ;;
    lsp) protocol lsp "$@" ;;
    dap) protocol dap "$@" ;;
    protocol) protocol all "$@" ;;
    smoke) run_target check; run_target js; run_target protocol "$@" ;;
    ui) ui --fresh-session "$@" ;;
    clickthrough) ui --fresh-session --clickthrough --artifacts "$TEST_DIR/.artifacts-clickthrough" "$@" ;;
    assist-ui) ui --fresh-session --assist-only --entry-file assist_test.ny --artifacts "$TEST_DIR/.artifacts-assist" "$@" ;;
    syntax-ui) ui --fresh-session --syntax-only --entry-file syntax_test.ny --artifacts "$TEST_DIR/.artifacts-syntax" "$@" ;;
    headless-ui) NYTRIX_VSCODE_TEST_HEADLESS=1 ui --fresh-session "$@" ;;
    headless-clickthrough) NYTRIX_VSCODE_TEST_HEADLESS=1 ui --fresh-session --clickthrough --artifacts "$TEST_DIR/.artifacts-headless-clickthrough" "$@" ;;
    headless-syntax-ui) NYTRIX_VSCODE_TEST_HEADLESS=1 ui --fresh-session --syntax-only --entry-file syntax_test.ny --artifacts "$TEST_DIR/.artifacts-headless-syntax" "$@" ;;
    xephyr) "$TEST_DIR/xephyr-smoke.sh" "$@" ;;
    all|full) run_target smoke; run_target clickthrough "$@" ;;
    headless-all) run_target smoke; run_target headless-clickthrough "$@" ;;
    -h|--help|help) usage ;;
    *) usage >&2; exit 2 ;;
  esac
}

run_target "${1:-smoke}" "${@:2}"

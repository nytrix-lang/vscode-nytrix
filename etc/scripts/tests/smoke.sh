#!/usr/bin/env bash
set -euo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${NYTRIX_VSCODE_EXTENSION_ROOT:-$(cd "$TEST_DIR/.." && pwd)}"
REPO_ROOT="${NYTRIX_REPO_ROOT:-$(cd "$ROOT/.." && pwd)}"
TEST_ROOT="${NYTRIX_VSCODE_TEST_ROOT:-/tmp/nytrix-vscode-test}"
LOCK_DIR="${TEST_ROOT}.lock"
HOST_DISPLAY="${DISPLAY:-}"
CODE_BIN="${CODE_BIN:-$(command -v code)}"
LSP_BIN="${NYTRIX_LSP_BIN:-$REPO_ROOT/build/release/ny-lsp}"
NY_BIN="${NYTRIX_BIN:-$REPO_ROOT/build/release/ny}"
EXT_DIR="$TEST_ROOT/extensions/x3ric.nytrix-0.1.0"
USER_DIR="$TEST_ROOT/user-data"
WORK_DIR="$TEST_ROOT/workspace"
LOG_DIR="$TEST_ROOT/logs"
SESSION_JSON="$TEST_ROOT/session.json"
AUTO_DISMISS_SIGNIN="${NYTRIX_VSCODE_TEST_AUTODISMISS_SIGNIN:-1}"
ENTRY_FILE="${NYTRIX_VSCODE_TEST_ENTRY:-hover_test.ny}"
FULLSCREEN="${NYTRIX_VSCODE_TEST_FULLSCREEN:-1}"
RESTORE_FOCUS="${NYTRIX_VSCODE_TEST_RESTORE_FOCUS:-1}"
NO_HOST_GRAB="${NYTRIX_VSCODE_TEST_NO_HOST_GRAB:-1}"
HOST_FULLSCREEN_MODE="${NYTRIX_VSCODE_TEST_HOST_FULLSCREEN_MODE:-maximize}"
REUSE_SESSION="${NYTRIX_VSCODE_TEST_REUSE:-1}"
HEADLESS="${NYTRIX_VSCODE_TEST_HEADLESS:-0}"
CLOSE_OLD="${NYTRIX_VSCODE_TEST_CLOSE_OLD:-1}"
DISPLAY_SERVER="Xephyr"

extension_fingerprint() {
  (
    cd "$ROOT"
    find src snippets -type f -print
    printf '%s\n' package.json language-configuration.json nytrix.tmLanguage.json README.md
  ) | sort | xargs sha1sum | sha1sum | awk '{print $1}'
}

session_field_from() {
  python3 - "$1" "$2" <<'PY'
import json, sys
with open(sys.argv[1], "r", encoding="utf-8") as fh:
    data = json.load(fh)
value = data.get(sys.argv[2], "")
if isinstance(value, bool):
    print("1" if value else "0")
else:
    print(value)
PY
}

session_field() {
  session_field_from "$SESSION_JSON" "$1"
}

pid_alive() {
  local pid="${1:-0}"
  [[ -n "$pid" && "$pid" != "0" ]] && kill -0 "$pid" 2>/dev/null
}

cleanup_existing_session() {
  [[ -f "$SESSION_JSON" ]] || return 0
  local old_xephyr old_code
  old_xephyr="$(session_field xephyr_pid)"
  old_code="$(session_field code_pid)"
  pkill -TERM -P "$old_code" 2>/dev/null || true
  pkill -TERM -P "$old_xephyr" 2>/dev/null || true
  kill "$old_code" "$old_xephyr" 2>/dev/null || true
  sleep 0.5
  pkill -KILL -P "$old_code" 2>/dev/null || true
  pkill -KILL -P "$old_xephyr" 2>/dev/null || true
  kill -KILL "$old_code" "$old_xephyr" 2>/dev/null || true
}

cleanup_session_file() {
  local session_path="${1:-}"
  [[ -f "$session_path" ]] || return 0
  local old_xephyr old_code
  old_xephyr="$(session_field_from "$session_path" xephyr_pid)"
  old_code="$(session_field_from "$session_path" code_pid)"
  pkill -TERM -P "$old_code" 2>/dev/null || true
  pkill -TERM -P "$old_xephyr" 2>/dev/null || true
  kill "$old_code" "$old_xephyr" 2>/dev/null || true
  sleep 0.3
  pkill -KILL -P "$old_code" 2>/dev/null || true
  pkill -KILL -P "$old_xephyr" 2>/dev/null || true
  kill -KILL "$old_code" "$old_xephyr" 2>/dev/null || true
}

cleanup_other_sessions() {
  local root_parent current_root session_path root_name_prefix
  root_parent="$(dirname "$TEST_ROOT")"
  current_root="$(realpath -m "$TEST_ROOT")"
  root_name_prefix="$(basename "$TEST_ROOT")"
  if [[ "$root_name_prefix" == nytrix-vscode-test* ]]; then
    root_name_prefix="nytrix-vscode-test"
  fi
  while IFS= read -r session_path; do
    local session_root
    session_root="$(dirname "$session_path")"
    session_root="$(realpath -m "$session_root")"
    if [[ "$session_root" == "$current_root" ]]; then
      continue
    fi
    cleanup_session_file "$session_path"
  done < <(find "$root_parent" -maxdepth 1 -type d -name "${root_name_prefix}*" -print 2>/dev/null | while read -r root_dir; do
    if [[ -f "$root_dir/session.json" ]]; then
      printf '%s\n' "$root_dir/session.json"
    fi
  done | sort)
}

print_launch_info() {
  local reused_flag="${1:-0}"
  local display_value="${2:-$DISPLAY_NUM}"
  local workspace_value="${3:-$WORK_DIR/$ENTRY_FILE}"
  local xephyr_value="${4:-$XEPHYR_PID}"
  local code_value="${5:-$CODE_PID}"
  cat <<EOF
Xephyr display: $display_value
Sandbox root: $TEST_ROOT
Workspace file: $workspace_value
Extension dir: $EXT_DIR
User data dir: $USER_DIR
Xephyr pid: $xephyr_value
Code pid: $code_value
Session json: $SESSION_JSON
Session reused: $reused_flag
Display server: $DISPLAY_SERVER
Host output: ${HOST_OUTPUT:-<none>}
Screen: $SCREEN
Fullscreen: $FULLSCREEN
Host fullscreen mode: $HOST_FULLSCREEN_MODE
Restore focus: $RESTORE_FOCUS
No host grab: $NO_HOST_GRAB

Use:
  DISPLAY=$display_value xwininfo -root -tree
  DISPLAY=$display_value $TEST_DIR/keysend.py activate 0x<window-id>
  kill $code_value $xephyr_value
EOF
}

choose_display() {
  if [[ -n "${NYTRIX_VSCODE_TEST_DISPLAY:-}" ]]; then
    printf '%s\n' "$NYTRIX_VSCODE_TEST_DISPLAY"
    return 0
  fi
  local n
  for n in $(seq 99 109); do
    if [[ -e "/tmp/.X${n}-lock" ]]; then
      continue
    fi
    printf ':%s\n' "$n"
    return 0
  done
  printf ':99\n'
}

detect_output() {
  if [[ -n "${NYTRIX_VSCODE_TEST_OUTPUT:-}" ]]; then
    printf '%s\n' "$NYTRIX_VSCODE_TEST_OUTPUT"
    return 0
  fi
  if [[ -z "$HOST_DISPLAY" ]]; then
    return 0
  fi
  DISPLAY="$HOST_DISPLAY" xrandr --current 2>/dev/null |
    awk '/ connected primary /{print $1; exit} / connected /{print $1; exit}'
}

detect_screen() {
  if [[ -n "${NYTRIX_VSCODE_TEST_SCREEN:-}" ]]; then
    printf '%s\n' "$NYTRIX_VSCODE_TEST_SCREEN"
    return 0
  fi
  if [[ -n "$HOST_DISPLAY" ]]; then
    local screen
    screen="$(
      DISPLAY="$HOST_DISPLAY" xrandr --current 2>/dev/null |
        awk '/ connected primary /{split($3,a,"+"); print a[1]; exit} / connected /{split($3,a,"+"); print a[1]; exit}'
    )"
    if [[ -n "$screen" ]]; then
      printf '%s\n' "$screen"
      return 0
    fi
  fi
  printf '1400x900\n'
}

detect_active_window() {
  if [[ -z "$HOST_DISPLAY" ]]; then
    return 0
  fi
  DISPLAY="$HOST_DISPLAY" xprop -root _NET_ACTIVE_WINDOW 2>/dev/null |
    sed -n 's/.*window id # \(0x[0-9a-fA-F]\+\).*/\1/p'
}

DISPLAY_NUM="$(choose_display)"
HOST_OUTPUT="$(detect_output)"
SCREEN="$(detect_screen)"
HOST_ACTIVE_WINDOW="$(detect_active_window)"
EXT_FINGERPRINT="$(extension_fingerprint)"
SESSION_HOST_DISPLAY="$HOST_DISPLAY"

if [[ "$HEADLESS" != "0" ]]; then
  DISPLAY_SERVER="Xvfb"
  FULLSCREEN=0
  RESTORE_FOCUS=0
  SESSION_HOST_DISPLAY=""
  HOST_OUTPUT=""
  HOST_ACTIVE_WINDOW=""
fi

if [[ -z "$CODE_BIN" ]]; then
  echo "code not found" >&2
  exit 1
fi
if [[ "$HEADLESS" != "0" ]]; then
  if ! command -v Xvfb >/dev/null 2>&1; then
    echo "Xvfb not found" >&2
    exit 1
  fi
else
  if ! command -v Xephyr >/dev/null 2>&1; then
    echo "Xephyr not found" >&2
    exit 1
  fi
fi

mkdir -p "$(dirname "$TEST_ROOT")"
lock_tries=0
while ! mkdir "$LOCK_DIR" 2>/dev/null; do
  lock_tries=$((lock_tries + 1))
  if (( lock_tries > 200 )); then
    echo "timed out waiting for Xephyr test lock: $LOCK_DIR" >&2
    exit 1
  fi
  sleep 0.1
done
trap 'rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT

if [[ "$CLOSE_OLD" != "0" ]]; then
  cleanup_other_sessions
fi

SESSION_REUSED=0
if [[ -f "$SESSION_JSON" ]]; then
  old_xephyr="$(session_field xephyr_pid)"
  old_code="$(session_field code_pid)"
  old_fingerprint="$(session_field extension_fingerprint)"
  old_display="$(session_field display)"
  old_workspace="$(session_field workspace_file)"
  if [[ "$REUSE_SESSION" != "0" ]] && [[ "$old_fingerprint" == "$EXT_FINGERPRINT" ]] && pid_alive "$old_xephyr" && pid_alive "$old_code"; then
    SESSION_REUSED=1
    DISPLAY_NUM="$old_display"
  else
    cleanup_existing_session
    rm -rf "$TEST_ROOT"
  fi
fi

mkdir -p "$EXT_DIR" "$USER_DIR/User" "$WORK_DIR" "$LOG_DIR"
if [[ "$SESSION_REUSED" == "0" ]]; then
  rsync -a --delete \
    --exclude '.git' \
    "$ROOT/" "$EXT_DIR/"
fi

cat >"$USER_DIR/User/settings.json" <<JSON
{
  "security.workspace.trust.enabled": false,
  "window.restoreWindows": "none",
  "window.commandCenter": false,
  "workbench.startupEditor": "none",
  "workbench.welcomePage.walkthroughs.openOnInstall": false,
  "workbench.tips.enabled": false,
  "workbench.layoutControl.enabled": false,
  "workbench.secondarySideBar.defaultVisibility": "hidden",
  "chat.agent.enabled": false,
  "workbench.browser.enableChatTools": false,
  "extensions.ignoreRecommendations": true,
  "chat.commandCenter.enabled": false,
  "telemetry.telemetryLevel": "off",
  "update.mode": "none",
  "files.associations": {
    "*.ny": "nytrix"
  },
  "nytrix.path": "$NY_BIN",
  "nytrix.lsp.enabled": true,
  "nytrix.lsp.path": "$LSP_BIN",
  "nytrix.test.runtimeSuitePath": "etc/tests/rt",
  "nytrix.repl.revealTerminal": false
}
JSON

cat >"$WORK_DIR/hover_test.ny" <<'NY'
use std.os
use std.os.path

fn add_one(value){
   "Increment a value."
   return value + 1
}

fn join_tag(prefix, name){
   "Builds a compact prefix:name label."
   return prefix + ":" + name
}

def demo_name = join_tag("arch", arch())

print(add_one(41))
print(demo_name)
print(sep())
NY

cat >"$WORK_DIR/syntax_test.ny" <<'NY'
def config_json = "{\"name\":\"Nytrix\",\"fps\":10000,\"ok\":true}"
def scene_xml = "<scene arch=\"x86_64\"><fps>10000</fps></scene>"
def page_html = "<div class=\"card\"><strong>Nytrix</strong></div>"
def bench_sql = "select fps, name from bench where fps > 9000 order by fps desc"
def settings_ini = "[core]\nname=Nytrix\nmode=dev"
def build_yaml = "name: Nytrix\nfps: 10000\nok: true"
def filter_regex = "^(arch|fps)_[0-9]+$"
def tiny_asm = "mov rax, 1\nadd rax, 2\nret"
def arm_assembly = "mov x0, #1\nadd x0, x0, #2\nret"
def inline_asm = asm("mov %rax, %rbx\nadd $1, %rax\nret")

print(config_json)
print(scene_xml)
print(page_html)
print(bench_sql)
print(settings_ini)
print(build_yaml)
print(filter_regex)
print(tiny_asm)
print(arm_assembly)
NY

cat >"$WORK_DIR/check_fail.ny" <<'NY'
use std.os

fn broken(value){
   return value +
}

print(broken(41))
NY

cat >"$WORK_DIR/assist_test.ny" <<'NY'
use std.os *
use std.core(print)

fn helper(value){
   return value + 1
}

print(helper(41))
NY

cat >"$WORK_DIR/format_test.ny" <<'NY'
use std.os *
use std.core(print)

print(arch())
NY

if [[ "$SESSION_REUSED" == "1" ]]; then
  print_launch_info 1 "$DISPLAY_NUM" "$old_workspace" "$old_xephyr" "$old_code"
  exit 0
fi

XEPHYR_ARGS=("$DISPLAY_NUM" -screen "$SCREEN" -title "Nytrix Xephyr" -name "nytrix-xephyr" -resizeable)
if [[ "$NO_HOST_GRAB" != "0" ]]; then
  XEPHYR_ARGS+=(-no-host-grab)
fi

CODE_ARGS=(
  --user-data-dir "$USER_DIR"
  --extensions-dir "$TEST_ROOT/extensions"
  --sync off
  --ozone-platform=x11
  --disable-gpu
  --skip-welcome
  --skip-sessions-welcome
  --skip-release-notes
  --skip-add-to-recently-opened
  --disable-updates
  --disable-experiments
  --disable-workspace-trust
  --disable-telemetry
  --disable-extension GitHub.copilot
  --disable-extension GitHub.copilot-chat
  --disable-extension vscode.github-authentication
  --disable-extension vscode.microsoft-authentication
  --disable-extension TypeScriptTeam.jsts-chat-features
  --disable-extension vscode.mermaid-chat-features
  --disable-extension openai.chatgpt
  --new-window "$WORK_DIR/$ENTRY_FILE"
)

if [[ "$HEADLESS" != "0" ]]; then
  nohup Xvfb "$DISPLAY_NUM" -screen 0 "$SCREEN"x24 >"$LOG_DIR/xephyr.log" 2>&1 </dev/null &
  XEPHYR_PID=$!
else
  nohup Xephyr "${XEPHYR_ARGS[@]}" >"$LOG_DIR/xephyr.log" 2>&1 </dev/null &
  XEPHYR_PID=$!
fi
sleep 1

nohup env DISPLAY="$DISPLAY_NUM" "$CODE_BIN" "${CODE_ARGS[@]}" >"$LOG_DIR/code.log" 2>&1 </dev/null &
CODE_PID=$!

cat >"$SESSION_JSON" <<JSON
{
  "display": "$DISPLAY_NUM",
  "sandbox_root": "$TEST_ROOT",
  "workspace_file": "$WORK_DIR/$ENTRY_FILE",
  "code_bin": "$CODE_BIN",
  "extension_dir": "$EXT_DIR",
  "user_data_dir": "$USER_DIR",
  "host_display": "$SESSION_HOST_DISPLAY",
  "host_output": "$HOST_OUTPUT",
  "screen": "$SCREEN",
  "fullscreen": $FULLSCREEN,
  "host_fullscreen_mode": "$HOST_FULLSCREEN_MODE",
  "restore_focus": $RESTORE_FOCUS,
  "no_host_grab": $NO_HOST_GRAB,
  "host_active_window": "$HOST_ACTIVE_WINDOW",
  "extension_fingerprint": "$EXT_FINGERPRINT",
  "xephyr_pid": $XEPHYR_PID,
  "code_pid": $CODE_PID
}
JSON

if [[ "$HEADLESS" == "0" && -n "$HOST_DISPLAY" && ( "$FULLSCREEN" != "0" || "$RESTORE_FOCUS" != "0" ) ]]; then
  (
    HOST_XEPHYR_WIN="$(DISPLAY="$HOST_DISPLAY" "$TEST_DIR/keysend.py" wait-window 20 'Nytrix Xephyr' 2>/dev/null || true)"
    if [[ -n "$HOST_XEPHYR_WIN" && "$FULLSCREEN" != "0" ]]; then
      if [[ "$HOST_FULLSCREEN_MODE" == "maximize" ]]; then
        DISPLAY="$HOST_DISPLAY" "$TEST_DIR/keysend.py" maximize-window "$HOST_XEPHYR_WIN" || true
      else
        DISPLAY="$HOST_DISPLAY" "$TEST_DIR/keysend.py" fullscreen-window "$HOST_XEPHYR_WIN" || true
      fi
    fi
    if [[ "$RESTORE_FOCUS" != "0" && -n "$HOST_ACTIVE_WINDOW" && "$HOST_ACTIVE_WINDOW" != "0x0" ]]; then
      sleep 1
      DISPLAY="$HOST_DISPLAY" "$TEST_DIR/keysend.py" activate "$HOST_ACTIVE_WINDOW" || true
    fi
  ) >/dev/null 2>&1 &
fi

if [[ "$AUTO_DISMISS_SIGNIN" != "0" ]]; then
  (
    WIN_ID="$(DISPLAY="$DISPLAY_NUM" "$TEST_DIR/keysend.py" wait-window 20 2>/dev/null || true)"
    if [[ -n "$WIN_ID" ]]; then
      sleep 2
      DISPLAY="$DISPLAY_NUM" "$TEST_DIR/keysend.py" activate "$WIN_ID" || true
      DISPLAY="$DISPLAY_NUM" "$TEST_DIR/keysend.py" key Escape || true
      sleep 1
      DISPLAY="$DISPLAY_NUM" "$TEST_DIR/keysend.py" click-window "$WIN_ID" 1050 145 1 || true
    fi
  ) >/dev/null 2>&1 &
fi

print_launch_info 0 "$DISPLAY_NUM" "$WORK_DIR/$ENTRY_FILE" "$XEPHYR_PID" "$CODE_PID"

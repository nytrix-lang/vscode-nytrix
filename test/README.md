# Nytrix VS Code Tests

Compact test harness for the Nytrix VS Code extension. One shell entrypoint runs everything:

```sh
cd /home/e/vscode-nytrix/test
./run.sh smoke
./run.sh all
./run.sh headless-all
```

Use `smoke` for fast local checks, `all` before publishing visible UI changes, and `headless-all` for CI or machines without a desktop session.

## Files

| File | Purpose |
| --- | --- |
| `run.sh` | single dispatcher for every target |
| `js_smoke.js` | bundled JS extension/unit smoke checks |
| `protocol_smoke.py` | raw real `ny-lsp` + `ny-dap` protocol checks |
| `ui_smoke.py` | VS Code UI/clickthrough/assist/syntax smoke runner |
| `xephyr-smoke.sh` | isolated VS Code sandbox launcher |
| `keysend.py` | focused X11 input helper used by UI tests |

## Targets

| Target | Covers |
| --- | --- |
| `js` / `unit` | JS metadata, bootstrap, code actions, debug symbol helpers |
| `lsp` | raw JSON-RPC language-server behavior |
| `dap` | raw `ny-dap` initialize/disconnect behavior |
| `protocol` | `lsp + dap` |
| `check` | `npm run check` |
| `validate` | `npm run validate` |
| `smoke` | `check + js + protocol` |
| `ui` | visible VS Code UI smoke |
| `clickthrough` | visible editor/menu flow with artifacts |
| `assist-ui` | focused assist/code-action UI pass |
| `syntax-ui` | focused grammar screenshot pass |
| `headless-ui` | UI smoke through Xvfb |
| `headless-clickthrough` | clickthrough through Xvfb |
| `headless-syntax-ui` | syntax UI through Xvfb |
| `xephyr` | raw sandbox launcher |
| `all` / `full` | `smoke + clickthrough` |
| `headless-all` | `smoke + headless-clickthrough` |

## Environment

| Variable | Purpose |
| --- | --- |
| `NYTRIX_REPO_ROOT` | override Nytrix repo discovery |
| `NYTRIX_VSCODE_EXTENSION_ROOT` | override extension root discovery |
| `NYTRIX_BIN` | path to `ny` |
| `NYTRIX_LSP_BIN` / `NYTRIX_LSP` | path to `ny-lsp` |
| `NYTRIX_DAP_BIN` / `NYTRIX_DAP` | path to `ny-dap` |
| `CODE_BIN` | path to VS Code `code` binary |
| `NYTRIX_VSCODE_TEST_HEADLESS=1` | force Xvfb UI runs |
| `NYTRIX_VSCODE_TEST_DISPLAY=:99` | force display selection |
| `NYTRIX_VSCODE_TEST_CLOSE_OLD=0` | keep old sandboxes alive |

## Manual sandbox control

`./run.sh xephyr` prints the display, window id, workspace, and sandbox paths. Drive it manually with:

```sh
DISPLAY=:99 ./keysend.py activate 0x<window-id>
DISPLAY=:99 ./keysend.py key F12
DISPLAY=:99 ./keysend.py click-window 0x<window-id> 960 650 1
```

UI tests use private `user-data`, `extensions`, workspace, log, and artifact directories under `/tmp/nytrix-vscode-test*` by default.

# Nytrix VS Code Tests

Run:

```sh
cd /home/e/vscode-nytrix
npm run validate

cd test
./run.sh smoke
./run.sh headless-clickthrough
```

Use `npm run validate` for the compact JS smoke runner and manifest checks. Use
`./run.sh smoke` for `ny-lsp` and debug-adapter protocol checks. Use a UI target when changing
editor wiring, menus, keybindings, highlighting, or sandbox launch.

## Test Map

| Target | Covers | Runtime |
| --- | --- | --- |
| `npm run validate` | JS syntax, metadata/package rules, bootstrap/code-action/symbol smokes | short |
| `./run.sh smoke` | JS smokes plus raw LSP and DAP protocol checks | medium |
| `./run.sh clickthrough` | Visible VS Code session with command palette, diagnostics, and editor flow | long |
| `./run.sh headless-clickthrough` | Same UI path through `Xvfb` | long |
| `./run.sh syntax-ui` | Grammar/highlighting screenshots | long |
| `./run.sh full` | Protocol smoke plus visible clickthrough | longest |

## Files

- `js_smoke.js`: shared runner for the compact JS suite.
- `metadata_smoke.js`: package/manifest drift, commands, settings, walkthroughs, package contents.
- `bootstrap_smoke.js`: managed Nytrix checkout plan.
- `code_actions_smoke.js`: quick fixes, formatter/analyzer actions.
- `debug_symbol_smoke.js`: compiler-backed symbol index and debug helpers.
- `lsp_smoke.py`: raw JSON-RPC LSP behavior.
- `dap_smoke.py`: raw stdio DAP behavior.
- `ui_smoke.py`: automated VS Code session and screenshots.
- `xephyr-smoke.sh`: isolated VS Code sandbox launcher.
- `keysend.py`: targeted X11 input helper; `keysend.sh` is its wrapper.

## Commands

```sh
./run.sh js
./run.sh lsp
./run.sh dap
./run.sh headless-ui
```

`./run.sh xephyr` prints the sandbox paths and display id. To drive that window
manually:

```sh
DISPLAY=:99 ./keysend.sh activate 0x<window-id>
DISPLAY=:99 ./keysend.sh key F12
DISPLAY=:99 ./keysend.sh click-window 0x<window-id> 960 650 1
```

## Sandbox Rules

- Tests use private `user-data`, `extensions`, and artifact directories.
- UI runs auto-pick a display from `:99..:109` unless
  `NYTRIX_VSCODE_TEST_DISPLAY` is set.
- Fresh UI runs close older `nytrix-vscode-test*` sessions by default. Set
  `NYTRIX_VSCODE_TEST_CLOSE_OLD=0` only when intentionally comparing sessions.
- `NYTRIX_VSCODE_TEST_HEADLESS=1` switches UI runs to `Xvfb`.
- `keysend.sh` prefers `/tmp/ny_gui_venv/bin/python` because it has `python-xlib`
  on this machine.

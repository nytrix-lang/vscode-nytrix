Nytrix VS Code Tests
====================

TLDR:

```sh
cd /home/e/vscode-nytrix
npm run validate

cd test
./run.sh smoke
./run.sh headless-clickthrough
```

Use `npm run validate` for fast repo hygiene. Use `./run.sh smoke` when you
also want live `ny-lsp` and debug-adapter coverage. Use a UI target only when
you changed editor wiring, menus, keybindings, highlighting, or sandbox launch.

Test Map
--------

| Target | What it proves | Cost |
| --- | --- | --- |
| `npm run validate` | JS syntax, manifest metadata, packaging rules, bootstrap/code-action/symbol smokes | fast |
| `./run.sh smoke` | `validate`-style JS smokes plus raw LSP and DAP protocol checks | medium |
| `./run.sh clickthrough` | Visible VS Code session with command palette, diagnostics, and editor flow | slow |
| `./run.sh headless-clickthrough` | Same UI path through `Xvfb`, suitable for unattended runs | slow |
| `./run.sh syntax-ui` | Focused grammar/highlighting screenshots | slow |
| `./run.sh full` | Protocol smoke plus visible clickthrough | slowest |

Files
-----

- `metadata_smoke.js`: package/manifest drift, commands, settings, walkthroughs.
- `package_smoke.js`: package contents and generated-output guards.
- `bootstrap_smoke.js`: managed Nytrix checkout plan.
- `code_actions_smoke.js`: quick fixes, formatter/analyzer actions.
- `debug_symbol_smoke.js`: compiler-backed symbol index and debug helpers.
- `lsp_smoke.py`: raw JSON-RPC LSP behavior.
- `dap_smoke.py`: raw stdio DAP behavior.
- `ui_smoke.py`: automated VS Code session and screenshots.
- `xephyr-smoke.sh`: isolated VS Code sandbox launcher.
- `keysend.py` / `keysend.sh`: targeted X11 input helper.

Useful Commands
---------------

```sh
./run.sh metadata
./run.sh package
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

Sandbox Rules
-------------

- Tests use private `user-data`, `extensions`, and artifact directories.
- UI runs auto-pick a display from `:99..:109` unless
  `NYTRIX_VSCODE_TEST_DISPLAY` is set.
- Fresh UI runs close older `nytrix-vscode-test*` sessions by default. Set
  `NYTRIX_VSCODE_TEST_CLOSE_OLD=0` only when intentionally comparing sessions.
- `NYTRIX_VSCODE_TEST_HEADLESS=1` switches UI runs to `Xvfb`.
- `keysend.sh` prefers `/tmp/ny_gui_venv/bin/python` because it has `python-xlib`
  on this machine.

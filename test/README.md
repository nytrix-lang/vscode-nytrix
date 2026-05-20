Nytrix VS Code test harness

This folder keeps the manual and semi-automated editor testing tools together so
we can exercise the installed extension without stomping on the real desktop.

Layout:
- `run.sh`: compact entrypoint for the private harness targets.
- `keysend.py`: X11/XTest helper for targeting a specific display/window.
- `keysend.sh`: wrapper that prefers `/tmp/ny_gui_venv/bin/python` when present.
- `lsp_smoke.py`: raw JSON-RPC smoke test for hover, definition, references,
  completion, signature help, workspace symbols, and syntax diagnostics.
- `dap_smoke.py`: stdio DAP smoke for launch, breakpoints, stack frames,
  evaluate, modules, and clean termination.
- `bootstrap_smoke.js`: config/bootstrap-plan smoke for the extension-managed
  Nytrix checkout flow.
- `ui_smoke.py`: end-to-end VS Code/Xephyr smoke runner that captures
  screenshots plus session/log artifacts for the stable clickthrough path:
  command palette, editor baseline, compiler check, and host-window state. It
  also supports focused syntax-only and assist-only modes when we want to probe
  a narrower editor surface.
- `headless` mode uses `Xvfb` instead of `Xephyr`, which is the right answer
  for “headless Xephyr.” We still drive the same VS Code session and can still
  dump screenshots from the virtual display.
- `xephyr-smoke.sh`: launches an isolated Xephyr display, installs the local
  extension into a private VS Code sandbox, and opens a sample Nytrix file.

Typical flow:

```sh
cd tmp/projects/vscode-nytrix/test
./run.sh smoke
./run.sh ui
./run.sh clickthrough
./run.sh syntax-ui
./run.sh headless-clickthrough
./run.sh full
```

`run.sh xephyr` prints the temporary sandbox paths plus the Xephyr display it
chose.
You can then drive the window with:

```sh
DISPLAY=:99 ./keysend.sh activate 0x<window-id>
DISPLAY=:99 ./keysend.sh key F12
DISPLAY=:99 ./keysend.sh click 1 --ctrl
DISPLAY=:99 ./keysend.sh click-window 0x<window-id> 960 650 1
```

Notes:
- The helper intentionally targets an explicit window id so clicks stay
  independent from whatever you are doing on the main desktop.
- `Xephyr` is optional but strongly preferred for repeatable editor tests.
- `xephyr-smoke.sh` auto-picks a free display from `:99..:109` unless you set
  `NYTRIX_VSCODE_TEST_DISPLAY` yourself.
- The sandbox uses private `user-data` and `extensions` directories, so it will
  not touch the main VS Code profile.
- `ui_smoke.py --fresh-session` forces a brand-new sandbox root; otherwise the
  launcher can reuse a compatible session root and, more importantly, avoids
  running two competing Xephyr sandboxes at the same time.
- By default the launcher now closes older `nytrix-vscode-test*` sessions
  before a fresh run starts, so opening a new sandbox cleans up stale old
  nested windows automatically. Set `NYTRIX_VSCODE_TEST_CLOSE_OLD=0` only if
  you intentionally want multiple sessions alive at once.
- `keysend.sh` prefers `/tmp/ny_gui_venv/bin/python` because that environment
  already has `python-xlib` installed on this machine.
- `xephyr-smoke.sh` now launches the sandbox with `--sync off` and tries to
  dismiss any stray welcome/sign-in sheet by default so the nested session
  stays out of your way. It also disables the built-in Copilot/chat/auth
  extensions in the sandbox so the test window does not prompt for AI sign-in.
  Set `NYTRIX_VSCODE_TEST_AUTODISMISS_SIGNIN=0` only if you want to inspect
  that UI on purpose.
- The sandbox also hides VS Code's auxiliary/secondary sidebar by default so
  screenshots stay focused on the editor instead of the agent/chat aside.
- By default the launcher now maximizes Xephyr on the active host output,
  restores your previously focused host window, and uses `-no-host-grab` so the
  nested display does not trap your real keyboard/mouse session.
- Fullscreen is applied through the host window manager after Xephyr maps, which
  has been more stable here than Xephyr's direct `-output` fullscreen mode. Set
  `NYTRIX_VSCODE_TEST_HOST_FULLSCREEN_MODE=fullscreen` if you want true
  fullscreen instead of the default managed maximize behavior.
- `NYTRIX_VSCODE_TEST_HEADLESS=1` swaps the visible nested display for `Xvfb`,
  which is the supported fully headless backend.

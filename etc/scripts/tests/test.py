#!/usr/bin/env python3
"""
Nytrix VS Code Tests

Compact test harness for the Nytrix VS Code extension.

Usage:
  ./test.py smoke
  ./test.py all
  ./test.py headless-all

Use `smoke` for fast local checks, `all` before publishing visible UI changes, and `headless-all` for CI or machines without a desktop session.

Files:
  test.py: Unified python test runner and test suites (keysend, protocol, UI)
  smoke.js: Bundled JS extension/unit smoke checks
  smoke.sh: Isolated VS Code sandbox launcher

Targets:
  js / unit: JS metadata, bootstrap, code actions, debug symbol helpers
  lsp: Raw JSON-RPC language-server behavior
  dap: Raw ny-dap initialize/disconnect behavior
  protocol: lsp + dap
  check: npm run check
  validate: npm run validate
  smoke: check + js + protocol
  ui: Visible VS Code UI smoke
  clickthrough: Visible editor/menu flow with artifacts
  assist-ui: Focused assist/code-action UI pass
  syntax-ui: Focused grammar screenshot pass
  headless-ui: UI smoke through Xvfb
  headless-clickthrough: Clickthrough through Xvfb
  headless-syntax-ui: Syntax UI through Xvfb
  xephyr: Raw sandbox launcher
  all / full: smoke + clickthrough
  headless-all: smoke + headless-clickthrough

Environment:
  NYTRIX_REPO_ROOT: Override Nytrix repo discovery
  NYTRIX_VSCODE_EXTENSION_ROOT: Override extension root discovery
  NYTRIX_BIN: Path to ny
  NYTRIX_LSP_BIN / NYTRIX_LSP: Path to ny-lsp
  NYTRIX_DAP_BIN / NYTRIX_DAP: Path to ny-dap
  CODE_BIN: Path to VS Code code binary
  NYTRIX_VSCODE_TEST_HEADLESS=1: Force Xvfb UI runs
  NYTRIX_VSCODE_TEST_DISPLAY=:99: Force display selection
  NYTRIX_VSCODE_TEST_CLOSE_OLD=0: Keep old sandboxes alive
"""
import sys
sys.dont_write_bytecode = True
import argparse
import json
import os
import pathlib
import re
import shutil
import subprocess
import time

ROOT = pathlib.Path(__file__).resolve().parent.parent.parent
os.environ["NYTRIX_VSCODE_EXTENSION_ROOT"] = str(ROOT)

def run_keysend(args):
    try:
        from Xlib import X, XK, display, protocol
        from Xlib.ext import xtest
    except ImportError:
        print("Error: python3-xlib is not installed, which is required for keysend UI tasks.", file=sys.stderr)
        sys.exit(1)

    def keysym(name):
        ks = XK.string_to_keysym(name)
        if ks == 0:
            raise SystemExit(f"bad keysym {name}")
        return ks

    def keycode(disp, name):
        return disp.keysym_to_keycode(keysym(name))

    CHAR_KEYMAP = {
        "/": ("slash", False),
        "?": ("slash", True),
        ".": ("period", False),
        ">": ("period", True),
        ",": ("comma", False),
        "<": ("comma", True),
        ":": ("semicolon", True),
        ";": ("semicolon", False),
        "(": ("9", True),
        ")": ("0", True),
        '"': ("apostrophe", True),
        "'": ("apostrophe", False),
        "_": ("minus", True),
        "-": ("minus", False),
        "=": ("equal", False),
        "+": ("equal", True),
        "[": ("bracketleft", False),
        "{": ("bracketleft", True),
        "]": ("bracketright", False),
        "}": ("bracketright", True),
        "\\": ("backslash", False),
        "|": ("backslash", True),
        "`": ("grave", False),
        "~": ("grave", True),
        "!": ("1", True),
        "@": ("2", True),
        "#": ("3", True),
        "$": ("4", True),
        "%": ("5", True),
        "^": ("6", True),
        "&": ("7", True),
        "*": ("8", True),
        " ": ("space", False),
    }

    def char_key(ch):
        if ch in CHAR_KEYMAP:
            return CHAR_KEYMAP[ch]
        if ch.isalpha():
            return ch.lower(), ch.isupper()
        if ch.isdigit():
            return ch, False
        raise SystemExit(f"unsupported char {ch!r}")

    def parse_combo(spec):
        shift = ctrl = alt = False
        key_name = None
        for part in [piece.strip() for piece in spec.split("+") if piece.strip()]:
            lowered = part.lower()
            if lowered in ("ctrl", "control"):
                ctrl = True
            elif lowered == "shift":
                shift = True
            elif lowered in ("alt", "meta"):
                alt = True
            else:
                key_name = part
        if not key_name:
            raise SystemExit(f"bad combo {spec!r}")
        return key_name, shift, ctrl, alt

    def send_key(disp, name, shift=False, ctrl=False, alt=False):
        mods = []
        if shift:
            mods.append(keycode(disp, "Shift_L"))
        if ctrl:
            mods.append(keycode(disp, "Control_L"))
        if alt:
            mods.append(keycode(disp, "Alt_L"))
        for mod in mods:
            xtest.fake_input(disp, X.KeyPress, mod)
        xtest.fake_input(disp, X.KeyPress, keycode(disp, name))
        xtest.fake_input(disp, X.KeyRelease, keycode(disp, name))
        for mod in reversed(mods):
            xtest.fake_input(disp, X.KeyRelease, mod)
        disp.sync()

    def type_text(disp, text):
        for ch in text:
            if ch == "\n":
                send_key(disp, "Return")
                time.sleep(0.05)
                continue
            name, shift = char_key(ch)
            send_key(disp, name, shift=shift)
            time.sleep(0.02)

    def activate_window(disp, win_id):
        root = disp.screen().root
        atom_active = disp.intern_atom("_NET_ACTIVE_WINDOW")
        atom_current = disp.intern_atom("_NET_CURRENT_DESKTOP")
        atom_wm_desktop = disp.intern_atom("_NET_WM_DESKTOP")
        win = disp.create_resource_object("window", win_id)
        try:
            desktop = win.get_full_property(atom_wm_desktop, X.AnyPropertyType)
            if desktop and desktop.value is not None and len(desktop.value) > 0:
                root.send_event(
                    protocol.event.ClientMessage(
                        window=root,
                        client_type=atom_current,
                        data=(32, [int(desktop.value[0]), X.CurrentTime, 0, 0, 0]),
                    ),
                    event_mask=X.SubstructureRedirectMask | X.SubstructureNotifyMask,
                )
        except Exception:
            pass
        root.send_event(
            protocol.event.ClientMessage(
                window=win,
                client_type=atom_active,
                data=(32, [1, X.CurrentTime, win_id, 0, 0]),
            ),
            event_mask=X.SubstructureRedirectMask | X.SubstructureNotifyMask,
        )
        disp.sync()

    def window_geom(disp, win_id):
        win = disp.create_resource_object("window", win_id)
        geom = win.get_geometry()
        coords = win.translate_coords(disp.screen().root, 0, 0)
        return coords.x, coords.y, geom.width, geom.height

    def list_windows():
        out = subprocess.run(
            ["xwininfo", "-root", "-tree"],
            check=False,
            text=True,
            capture_output=True,
            env=os.environ,
        )
        if out.returncode != 0:
            return []
        windows = []
        for line in out.stdout.splitlines():
            match = re.match(r'\s*(0x[0-9a-fA-F]+)\s+"([^"]*)".*?(\d+)x(\d+)\+', line)
            if not match:
                continue
            win_id, name, width, height = match.groups()
            windows.append((win_id, name, int(width), int(height)))
        return windows

    def find_window(needle="Visual Studio Code"):
        prefer_code_window = not needle or needle == "Visual Studio Code"
        best_id = None
        best_area = -1
        best_name = ""
        for win_id, name, width, height in list_windows():
            if needle and needle not in name:
                continue
            if prefer_code_window and "Visual Studio Code" not in name and "Code" not in name:
                continue
            area = width * height
            if area > best_area or (area == best_area and name > best_name):
                best_id = win_id
                best_area = area
                best_name = name
        return best_id

    def active_window_id(disp):
        atom_active = disp.intern_atom("_NET_ACTIVE_WINDOW")
        prop = disp.screen().root.get_full_property(atom_active, X.AnyPropertyType)
        if not prop or prop.value is None or len(prop.value) == 0:
            return None
        win_id = int(prop.value[0])
        if win_id == 0:
            return None
        return win_id

    def wm_state_names(disp, win_id):
        atom_state = disp.intern_atom("_NET_WM_STATE")
        win = disp.create_resource_object("window", win_id)
        prop = win.get_full_property(atom_state, X.AnyPropertyType)
        if not prop or prop.value is None:
            return []
        return [disp.get_atom_name(int(atom)) for atom in prop.value]

    def click(disp, button=1, shift=False, ctrl=False, alt=False):
        mods = []
        if shift:
            mods.append(keycode(disp, "Shift_L"))
        if ctrl:
            mods.append(keycode(disp, "Control_L"))
        if alt:
            mods.append(keycode(disp, "Alt_L"))
        for mod in mods:
            xtest.fake_input(disp, X.KeyPress, mod)
        xtest.fake_input(disp, X.ButtonPress, button)
        xtest.fake_input(disp, X.ButtonRelease, button)
        for mod in reversed(mods):
            xtest.fake_input(disp, X.KeyRelease, mod)
        disp.sync()

    def set_wm_state(disp, win_id, atoms, action=1):
        root = disp.screen().root
        atom_state = disp.intern_atom("_NET_WM_STATE")
        atom_values = [disp.intern_atom(name) for name in atoms]
        while len(atom_values) < 2:
            atom_values.append(0)
        event = protocol.event.ClientMessage(
            window=disp.create_resource_object("window", win_id),
            client_type=atom_state,
            data=(32, [action, atom_values[0], atom_values[1], 1, 0]),
        )
        root.send_event(event, event_mask=X.SubstructureRedirectMask | X.SubstructureNotifyMask)
        disp.sync()

    if len(args) < 1:
        raise SystemExit("usage: test.py keysend <activate|active-window|find-window|wait-window|window-geom|wm-state|fullscreen-window|maximize-window|key|combo|repeat-key|type|move|click> ...")
    cmd = args[0]
    if cmd == "activate":
        activate_window(disp, int(args[1], 0))
    elif cmd == "active-window":
        win_id = active_window_id(disp)
        if win_id is None:
            raise SystemExit(1)
        print(hex(win_id))
    elif cmd == "find-window":
        needle = args[1] if len(args) > 1 else "Visual Studio Code"
        win_id = find_window(needle)
        if not win_id:
            raise SystemExit(1)
        print(win_id)
    elif cmd == "wait-window":
        timeout = float(args[1])
        needle = args[2] if len(args) > 2 else "Visual Studio Code"
        deadline = time.time() + timeout
        while time.time() < deadline:
            win_id = find_window(needle)
            if win_id:
                print(win_id)
                return
            time.sleep(0.2)
        raise SystemExit(1)
    elif cmd == "type":
        time.sleep(0.2)
        type_text(disp, args[1])
    elif cmd == "key":
        send_key(
            disp,
            args[1],
            shift="--shift" in args,
            ctrl="--ctrl" in args,
            alt="--alt" in args,
        )
    elif cmd == "combo":
        key_name, shift, ctrl, alt = parse_combo(args[1])
        send_key(disp, key_name, shift=shift, ctrl=ctrl, alt=alt)
    elif cmd == "repeat-key":
        count = int(args[1])
        key_name = args[2]
        shift = "--shift" in args
        ctrl = "--ctrl" in args
        alt = "--alt" in args
        delay = 0.02
        for arg in args[3:]:
            if arg.startswith("--delay="):
                delay = float(arg.split("=", 1)[1])
        for _ in range(max(0, count)):
            send_key(disp, key_name, shift=shift, ctrl=ctrl, alt=alt)
            time.sleep(delay)
    elif cmd == "move":
        root.warp_pointer(int(args[1]), int(args[2]))
        disp.sync()
    elif cmd == "move-window":
        win_id = int(args[1], 0)
        rel_x = int(args[2])
        rel_y = int(args[3])
        abs_x, abs_y, _, _ = window_geom(disp, win_id)
        root.warp_pointer(abs_x + rel_x, abs_y + rel_y)
        disp.sync()
    elif cmd == "window-geom":
        x, y, width, height = window_geom(disp, int(args[1], 0))
        print(f"{x} {y} {width} {height}")
    elif cmd == "wm-state":
        states = wm_state_names(disp, int(args[1], 0))
        print(" ".join(states))
    elif cmd == "fullscreen-window":
        set_wm_state(disp, int(args[1], 0), ["_NET_WM_STATE_FULLSCREEN"])
    elif cmd == "maximize-window":
        set_wm_state(
            disp,
            int(args[1], 0),
            ["_NET_WM_STATE_MAXIMIZED_VERT", "_NET_WM_STATE_MAXIMIZED_HORZ"],
        )
    elif cmd == "click":
        button = int(args[1]) if len(args) > 1 and not args[1].startswith("--") else 1
        click(
            disp,
            button=button,
            shift="--shift" in args,
            ctrl="--ctrl" in args,
            alt="--alt" in args,
        )
    elif cmd == "click-window":
        win_id = int(args[1], 0)
        rel_x = int(args[2])
        rel_y = int(args[3])
        button = int(args[4]) if len(args) > 4 and not args[4].startswith("--") else 1
        abs_x, abs_y, _, _ = window_geom(disp, win_id)
        root.warp_pointer(abs_x + rel_x, abs_y + rel_y)
        disp.sync()
        click(
            disp,
            button=button,
            shift="--shift" in args,
            ctrl="--ctrl" in args,
            alt="--alt" in args,
        )
    else:
        raise SystemExit(f"unknown keysend command {cmd}")

def run_protocol(argv):
    def find_tool(names, rel):
        if isinstance(names, str):
            names = [names]
        for name in names:
            value = os.environ.get(name)
            if value:
                return value
        test_dir = pathlib.Path(__file__).resolve().parent
        root_dir = test_dir
        for start in (pathlib.Path.cwd(), root_dir, pathlib.Path.home() / "nytrix"):
            for cur in (start, *start.parents):
                candidate = cur / "build" / "release" / rel
                if candidate.exists():
                    return str(candidate)
        return shutil.which(rel) or rel

    def require_tool(path, label):
        if os.path.sep in path or os.path.isabs(path):
            if os.path.exists(path):
                return path
            raise SystemExit(f"{label} not found: {path}")
        found = shutil.which(path)
        if found:
            return found
        raise SystemExit(f"{label} not found on PATH")

    def send(proc, payload):
        body = json.dumps(payload, separators=(",", ":")).encode()
        proc.stdin.write(f"Content-Length: {len(body)}\r\n\r\n".encode() + body)
        proc.stdin.flush()

    def recv(proc, timeout=10.0):
        deadline = time.time() + timeout
        header = b""
        while b"\r\n\r\n" not in header:
            if time.time() > deadline:
                raise TimeoutError("protocol response timed out")
            ch = proc.stdout.read(1)
            if not ch:
                err = proc.stderr.read().decode("utf-8", "replace")
                raise RuntimeError(err or "protocol server exited")
            header += ch
        length = 0
        for line in header.decode("ascii", "replace").splitlines():
            if line.lower().startswith("content-length:"):
                length = int(line.split(":", 1)[1].strip())
                break
        if length <= 0:
            raise RuntimeError(f"missing Content-Length: {header!r}")
        return json.loads(proc.stdout.read(length).decode())

    def smoke_lsp(exe):
        proc = subprocess.Popen([exe], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            send(proc, {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"capabilities":{}}})
            msg = recv(proc)
            caps = msg.get("result", {}).get("capabilities", {})
            assert caps.get("hoverProvider") is True, "ny-lsp hoverProvider missing"
            assert caps.get("definitionProvider") is True, "ny-lsp definitionProvider missing"
            send(proc, {"jsonrpc":"2.0","method":"exit","params":{}})
            print("lsp smoke: ok")
        finally:
            proc.kill()

    def smoke_dap(exe):
        proc = subprocess.Popen([exe], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            send(proc, {"seq":1,"type":"request","command":"initialize","arguments":{"adapterID":"nytrix","linesStartAt1":True,"columnsStartAt1":True}})
            msg = recv(proc)
            assert msg.get("type") == "response" and msg.get("success") is True, f"ny-dap initialize failed: {msg!r}"
            send(proc, {"seq":2,"type":"request","command":"disconnect","arguments":{}})
            print("dap smoke: ok")
        finally:
            proc.kill()

    parser = argparse.ArgumentParser(description="Protocol checks")
    parser.add_argument("target", nargs="?", default="all", choices=("all", "lsp", "dap"))
    parser.add_argument("--ny-lsp", default=find_tool(["NYTRIX_LSP_BIN", "NYTRIX_LSP"], "ny-lsp"))
    parser.add_argument("--ny-dap", default=find_tool(["NYTRIX_DAP_BIN", "NYTRIX_DAP"], "ny-dap"))
    args = parser.parse_args(argv)
    
    if args.target in ("all", "lsp"):
        smoke_lsp(require_tool(args.ny_lsp, "ny-lsp"))
    if args.target in ("all", "dap"):
        smoke_dap(require_tool(args.ny_dap, "ny-dap"))

def run_ui(argv):
    def run_cmd(cmd, **kwargs):
        timeout = kwargs.pop("timeout", 20)
        return subprocess.run(cmd, check=True, text=True, capture_output=True, timeout=timeout, **kwargs)

    def maybe_run(cmd, **kwargs):
        timeout = kwargs.pop("timeout", 20)
        return subprocess.run(cmd, check=False, text=True, capture_output=True, timeout=timeout, **kwargs)

    def run_retry(cmd, *, attempts=5, delay_s=0.35, **kwargs):
        last = None
        for _ in range(max(1, attempts)):
            result = maybe_run(cmd, **kwargs)
            if result.returncode == 0:
                return result
            last = result
            time.sleep(delay_s)
        raise subprocess.CalledProcessError(last.returncode, last.args, output=last.stdout, stderr=last.stderr)

    def parse_launch(stdout):
        data = {}
        for line in stdout.splitlines():
            if ":" not in line:
                continue
            key, value = line.split(":", 1)
            data[key.strip().lower().replace(" ", "_")] = value.strip()
        return data

    def wait_for_log_pattern(log_root, pattern, timeout_s):
        deadline = time.time() + timeout_s
        regex = re.compile(pattern)
        while time.time() < deadline:
            if os.path.isdir(log_root):
                for root_dir, _, files in os.walk(log_root):
                    for name in files:
                        if name.endswith(".jsonl"):
                            continue
                        path = os.path.join(root_dir, name)
                        try:
                            text = pathlib.Path(path).read_text(encoding="utf-8", errors="replace")
                        except OSError:
                            continue
                        if regex.search(text):
                            return path, text
            time.sleep(0.25)
        raise RuntimeError(f"timed out waiting for pattern {pattern!r} in {log_root}")

    def assert_no_log_pattern(log_root, pattern):
        regex = re.compile(pattern)
        hits = []
        if not os.path.isdir(log_root):
            return
        for root_dir, _, files in os.walk(log_root):
            for name in files:
                if name.endswith(".jsonl"):
                    continue
                path = os.path.join(root_dir, name)
                try:
                    text = pathlib.Path(path).read_text(encoding="utf-8", errors="replace")
                except OSError:
                    continue
                if regex.search(text):
                    hits.append(path)
        if hits:
            raise AssertionError(f"unexpected log pattern {pattern!r} in {hits}")

    def copy_if_exists(src, dst):
        if os.path.exists(src):
            shutil.copy2(src, dst)

    def cleanup_session(session):
        code_pid = str(session.get("code_pid", "0"))
        xephyr_pid = str(session.get("xephyr_pid", "0"))
        maybe_run(["pkill", "-TERM", "-P", code_pid])
        maybe_run(["pkill", "-TERM", "-P", xephyr_pid])
        maybe_run(["kill", code_pid, xephyr_pid])
        time.sleep(0.5)
        maybe_run(["pkill", "-KILL", "-P", code_pid])
        maybe_run(["pkill", "-KILL", "-P", xephyr_pid])
        maybe_run(["kill", "-KILL", code_pid, xephyr_pid])

    def press(env, key_name, *, shift=False, ctrl=False, alt=False, settle_s=0.35):
        cmd = [sys.executable, __file__, "keysend", "key", key_name]
        if shift:
            cmd.append("--shift")
        if ctrl:
            cmd.append("--ctrl")
        if alt:
            cmd.append("--alt")
        run_retry(cmd, env=env)
        time.sleep(settle_s)

    def combo(env, spec, *, settle_s=0.35):
        run_retry([sys.executable, __file__, "keysend", "combo", spec], env=env)
        time.sleep(settle_s)

    def type_text(env, text, *, settle_s=0.6):
        run_retry([sys.executable, __file__, "keysend", "type", text], env=env)
        time.sleep(settle_s)

    def click_window(env, win_id, x, y, *, button=1, settle_s=0.35):
        last = None
        for _ in range(5):
            result = maybe_run([sys.executable, __file__, "keysend", "click-window", win_id, str(x), str(y), str(button)], env=env)
            if result.returncode == 0:
                time.sleep(settle_s)
                return
            last = result
            time.sleep(0.35)
        if last and last.returncode != 0:
            raise subprocess.CalledProcessError(last.returncode, last.args, output=last.stdout, stderr=last.stderr)

    def capture_png(env, path, *, window="root"):
        run_cmd(["import", "-window", window, str(path)], env=env)

    def maybe_capture_png(env, path, *, window="root"):
        result = maybe_run(["import", "-window", window, str(path)], env=env)
        return result.returncode == 0, result.stderr

    def ocr_png(path):
        convert = subprocess.run(
            [
                "convert",
                str(path),
                "-colorspace",
                "Gray",
                "-resize",
                "200%",
                "-sharpen",
                "0x1",
                "png:-",
            ],
            check=True,
            capture_output=True,
        )
        ocr = subprocess.run(
            ["tesseract", "stdin", "stdout", "--psm", "6"],
            input=convert.stdout,
            check=True,
            capture_output=True,
        )
        return ocr.stdout.decode("utf-8", errors="replace")

    def normalize_text(text):
        return re.sub(r"\s+", " ", text).strip().lower()

    def assert_image_contains(path, needle, *, sidecar=None):
        text = ocr_png(path)
        if sidecar is not None:
            pathlib.Path(sidecar).write_text(text, encoding="utf-8")
        if normalize_text(needle) not in normalize_text(text):
            raise AssertionError(f"ocr for {path} missing {needle!r}:\n{text}")

    def save_file(env, *, settle_s=0.6):
        combo(env, "Ctrl+s", settle_s=settle_s)

    def wait_for_file_predicate(file_path, predicate, description, *, timeout_s=10.0):
        deadline = time.time() + timeout_s
        while time.time() < deadline:
            text = pathlib.Path(file_path).read_text(encoding="utf-8")
            if predicate(text):
                return text
            time.sleep(0.25)
        final = pathlib.Path(file_path).read_text(encoding="utf-8")
        raise AssertionError(f"timed out waiting for {description} in {file_path}:\n{final}")

    def record_step(artifacts, label):
        stamp = time.strftime("%H:%M:%S")
        with (artifacts / "timeline.txt").open("a", encoding="utf-8") as fh:
            fh.write(f"{stamp} {label}\n")

    def focus_editor(env, win_id):
        maybe_run([sys.executable, __file__, "keysend", "activate", win_id], env=env)
        time.sleep(0.2)
        maybe_run([sys.executable, __file__, "keysend", "combo", "Ctrl+1"], env=env)
        time.sleep(0.2)
        maybe_run([sys.executable, __file__, "keysend", "key", "Escape"], env=env)
        time.sleep(0.2)

    def goto_line_col(env, win_id, line_number, column_number):
        focus_editor(env, win_id)
        combo(env, "Ctrl+g", settle_s=0.45)
        type_text(env, f"{line_number}:{column_number}", settle_s=0.25)
        press(env, "Return", settle_s=0.45)

    def find_nth(text, needle, occurrence=1):
        start = 0
        for _ in range(max(1, occurrence)):
            idx = text.find(needle, start)
            if idx < 0:
                raise AssertionError(f"could not find {needle!r} occurrence {occurrence}")
            start = idx + len(needle)
        return idx

    def locate_token(file_path, needle, *, occurrence=1, char_offset=0):
        lines = pathlib.Path(file_path).read_text(encoding="utf-8").splitlines()
        for row, line in enumerate(lines, start=1):
            hits = line.count(needle)
            if hits < occurrence:
                occurrence -= hits
                continue
            col = find_nth(line, needle, occurrence) + 1 + char_offset
            return row, col
        raise AssertionError(f"could not locate {needle!r} in {file_path}")

    def focus_token(env, win_id, file_path, needle, *, occurrence=1, char_offset=0):
        line_number, column_number = locate_token(file_path, needle, occurrence=occurrence, char_offset=char_offset)
        goto_line_col(env, win_id, line_number, column_number)

    def dismiss_signin_overlay(env, win_id):
        for cmd in (
            [sys.executable, __file__, "keysend", "key", "Escape"],
            [sys.executable, __file__, "keysend", "click-window", win_id, "840", "650", "1"],
            [sys.executable, __file__, "keysend", "click-window", win_id, "930", "650", "1"],
            [sys.executable, __file__, "keysend", "click-window", win_id, "890", "145", "1"],
            [sys.executable, __file__, "keysend", "click-window", win_id, "1110", "145", "1"],
            [sys.executable, __file__, "keysend", "key", "Escape"],
        ):
            maybe_run(cmd, env=env)
            time.sleep(0.4)

    def run_palette_command(env, win_id, title, *, settle_open_s=0.6, settle_type_s=0.7, settle_exec_s=1.2):
        focus_editor(env, win_id)
        combo(env, "Ctrl+Shift+p", settle_s=settle_open_s)
        type_text(env, title, settle_s=settle_type_s)
        press(env, "Return", settle_s=settle_exec_s)

    def run_show_actions_item(env, win_id, label, *, settle_open_s=1.0, settle_type_s=0.6, settle_exec_s=1.8):
        run_palette_command(env, win_id, "Nytrix: Show Actions", settle_exec_s=settle_open_s)
        type_text(env, label, settle_s=settle_type_s)
        press(env, "Return", settle_s=settle_exec_s)

    def capture_show_actions_filter(env, win_id, label, artifact, *, settle_open_s=1.0, settle_type_s=0.7):
        run_palette_command(env, win_id, "Nytrix: Show Actions", settle_exec_s=settle_open_s)
        type_text(env, label, settle_s=settle_type_s)
        capture_png(env, artifact)
        press(env, "Escape", settle_s=0.4)

    def show_quick_fix_menu(env, win_id, *, settle_s=0.9):
        focus_editor(env, win_id)
        press(env, "period", ctrl=True, settle_s=settle_s)

    def stabilize_workspace(env, win_id):
        dismiss_signin_overlay(env, win_id)
        maybe_run([sys.executable, __file__, "keysend", "activate", win_id], env=env)
        time.sleep(0.25)
        maybe_run([sys.executable, __file__, "keysend", "key", "Escape"], env=env)
        time.sleep(0.15)
        maybe_run([sys.executable, __file__, "keysend", "key", "Escape"], env=env)
        time.sleep(0.15)
        focus_editor(env, win_id)
        press(env, "Escape", settle_s=0.2)

    def open_file(env, win_id, name, *, settle_s=0.9):
        focus_editor(env, win_id)
        press(env, "Escape", settle_s=0.2)
        press(env, "Escape", settle_s=0.2)
        combo(env, "Ctrl+p", settle_s=0.5)
        combo(env, "Ctrl+a", settle_s=0.2)
        type_text(env, name, settle_s=0.5)
        press(env, "Return", settle_s=settle_s)

    def wait_for_command_log(log_root, label, timeout_s):
        pattern = rf"== Nytrix {re.escape(label)} =="
        return wait_for_log_pattern(log_root, pattern, timeout_s)

    def run_tool_shortcut(env, win_id, key_name, *, settle_s=1.0):
        focus_editor(env, win_id)
        press(env, "Escape", settle_s=0.2)
        press(env, key_name, ctrl=True, alt=True, settle_s=settle_s)

    def parse_geom(text):
        x, y, width, height = (int(part) for part in text.split())
        return {"x": x, "y": y, "width": width, "height": height}

    def parse_screen(text):
        width, height = text.split("x", 1)
        return int(width), int(height)

    def assert_window_fills_screen(geom, screen, mode):
        screen_width, screen_height = screen
        min_width = int(screen_width * 0.8)
        min_height = int(screen_height * 0.8)
        if geom["width"] < min_width or geom["height"] < min_height:
            raise AssertionError(
                f"host window too small for {mode}: {geom['width']}x{geom['height']} vs screen {screen_width}x{screen_height}"
            )
        if geom["x"] < -32 or geom["y"] < -32:
            raise AssertionError(f"host window off-screen for {mode}: {geom}")

    def capture_workspace_symbol_flow(env, win_id, artifacts):
        record_step(artifacts, "inspect:workspace symbols")
        focus_editor(env, win_id)
        press(env, "s", ctrl=True, alt=True, shift=True, settle_s=0.8)
        type_text(env, "arch", settle_s=0.7)
        capture_png(env, artifacts / "08_workspace_symbol_results.png")
        press(env, "Escape", settle_s=0.5)

    def capture_document_symbol_flow(env, win_id, artifacts):
        record_step(artifacts, "inspect:file symbols")
        focus_editor(env, win_id)
        press(env, "s", ctrl=True, alt=True, settle_s=0.8)
        type_text(env, "join_tag", settle_s=0.7)
        capture_png(env, artifacts / "10_file_symbol_results.png")
        press(env, "Escape", settle_s=0.5)

    def run_assist_clickthrough(env, win_id, artifacts, workspace_dir, log_root, wait_seconds, *, already_open=False):
        check_file = workspace_dir / "check_fail.ny"
        assist_file = workspace_dir / "assist_test.ny"

        record_step(artifacts, "assist:open check_fail")
        open_file(env, win_id, "check_fail.ny")
        run_palette_command(env, win_id, "Nytrix: Check File", settle_exec_s=1.8)
        time.sleep(1.2)
        capture_png(env, artifacts / "17_check_fail_inline.png")

        record_step(artifacts, "assist:open assist_test")
        if already_open:
            open_file(env, win_id, "assist_test.ny")
        else:
            open_file(env, win_id, "assist_test.ny")
        capture_png(env, artifacts / "18_assist_editor_before.png")
        record_step(artifacts, "assist:run analyze")
        run_palette_command(env, win_id, "Nytrix: Analyze File", settle_exec_s=2.2)
        time.sleep(1.2)
        capture_png(env, artifacts / "19_assist_inline_hints.png")

        record_step(artifacts, "assist:show quick fix")
        focus_token(env, win_id, assist_file, "use std.os")
        show_quick_fix_menu(env, win_id, settle_s=1.0)
        capture_png(env, artifacts / "20_assist_quick_fix.png")
        press(env, "Escape", settle_s=0.4)

        record_step(artifacts, "assist:format file")
        run_palette_command(env, win_id, "Nytrix: Format File", settle_exec_s=2.2)
        save_file(env)
        assist_text = wait_for_file_predicate(
            assist_file,
            lambda text: "use std.os *" not in text and "use std.core(print)" not in text and "use std.core (print)" in text,
            "format file imports",
        )
        (artifacts / "21_assist_after_format_file.ny").write_text(assist_text, encoding="utf-8")
        time.sleep(0.8)
        capture_png(env, artifacts / "21_format_file_applied.png")
        record_step(artifacts, "assist:done")

    def capture_syntax_embed_flow(env, win_id, artifacts, syntax_file):
        record_step(artifacts, "syntax:open syntax_test")
        open_file(env, win_id, "syntax_test.ny")
        focus_token(env, win_id, syntax_file, "tiny_asm")
        capture_png(env, artifacts / "22_syntax_top.png")
        focus_token(env, win_id, syntax_file, "build_yaml")
        capture_png(env, artifacts / "23_syntax_bottom.png")

    ap = argparse.ArgumentParser()
    ap.add_argument("--artifacts", default=str(ROOT / ".artifacts"))
    ap.add_argument("--entry-file", default="hover_test.ny")
    ap.add_argument("--keep-session", action="store_true")
    ap.add_argument("--dismiss-signin", action="store_true")
    ap.add_argument("--syntax-only", action="store_true")
    ap.add_argument("--assist-only", action="store_true")
    ap.add_argument("--clickthrough", action="store_true")
    ap.add_argument("--fresh-session", action="store_true")
    ap.add_argument("--wait-seconds", type=float, default=90.0)
    args = ap.parse_args(argv)

    artifacts = pathlib.Path(args.artifacts)
    if artifacts.exists():
        shutil.rmtree(artifacts)
    artifacts.mkdir(parents=True, exist_ok=True)
    (artifacts / "timeline.txt").write_text("", encoding="utf-8")

    env = os.environ.copy()
    env.setdefault("NYTRIX_VSCODE_TEST_AUTODISMISS_SIGNIN", "1")
    if args.fresh_session:
        env["NYTRIX_VSCODE_TEST_ROOT"] = f"/tmp/nytrix-vscode-test-{os.getpid()}-fresh"
        env["NYTRIX_VSCODE_TEST_REUSE"] = "0"
    else:
        env.setdefault("NYTRIX_VSCODE_TEST_ROOT", "/tmp/nytrix-vscode-test")
        env.setdefault("NYTRIX_VSCODE_TEST_REUSE", "1")
    env["NYTRIX_VSCODE_TEST_ENTRY"] = args.entry_file
    if args.dismiss_signin:
        env["NYTRIX_VSCODE_TEST_AUTODISMISS_SIGNIN"] = "1"

    launch = run_cmd([str(ROOT / "scripts" / "smoke.sh")], env=env, timeout=60)
    info = parse_launch(launch.stdout)
    display = info["xephyr_display"]
    test_root = info["sandbox_root"]
    session_json = pathlib.Path(info["session_json"])
    session = json.loads(session_json.read_text(encoding="utf-8"))
    log_root = os.path.join(session["user_data_dir"], "logs")
    workspace_dir = pathlib.Path(test_root) / "workspace"
    hover_file = workspace_dir / "hover_test.ny"
    syntax_file = workspace_dir / "syntax_test.ny"

    keep_session = args.keep_session
    try:
        nested_env = {**env, "DISPLAY": display}
        win_id = run_cmd([sys.executable, __file__, "keysend", "wait-window", str(args.wait_seconds)], env=nested_env).stdout.strip()
        run_cmd([sys.executable, __file__, "keysend", "activate", win_id], env=nested_env)
        dismiss_signin_overlay(nested_env, win_id)
        stabilize_workspace(nested_env, win_id)

        ready_log = None
        try:
            ready_log, _ = wait_for_log_pattern(log_root, r"status\s+ready", min(args.wait_seconds, 12.0))
            assert_no_log_pattern(log_root, r"Server process exited|crashed 5 times|Connection to server got closed|documentSymbol failed|selectionRange")
        except RuntimeError:
            time.sleep(2.0)
        dismiss_signin_overlay(nested_env, win_id)
        stabilize_workspace(nested_env, win_id)
        time.sleep(4.0)

        capture_png(nested_env, artifacts / "01_ui_root.png")
        capture_png(nested_env, artifacts / "02_vscode_window.png", window=win_id)
        geom = run_cmd([sys.executable, __file__, "keysend", "window-geom", win_id], env=nested_env).stdout.strip()
        (artifacts / "window_geom.txt").write_text(geom + "\n", encoding="utf-8")
        (artifacts / "session.json").write_text(json.dumps(session, indent=2) + "\n", encoding="utf-8")
        (artifacts / "launch.txt").write_text(launch.stdout, encoding="utf-8")
        if ready_log:
            copy_if_exists(ready_log, artifacts / "nytrix.log")

        if args.syntax_only:
            capture_png(nested_env, artifacts / "03_syntax_top.png")
            focus_token(nested_env, win_id, syntax_file, "print(scene_xml)")
            capture_png(nested_env, artifacts / "04_syntax_bottom.png")
        elif args.assist_only:
            run_assist_clickthrough(
                nested_env,
                win_id,
                artifacts,
                workspace_dir,
                log_root,
                args.wait_seconds,
                already_open=True,
            )
        else:
            record_step(artifacts, "ui:show actions")
            run_palette_command(nested_env, win_id, "Nytrix: Show Actions", settle_exec_s=1.0)
            capture_png(nested_env, artifacts / "03_actions_palette.png")
            press(nested_env, "Escape", settle_s=0.4)

            record_step(artifacts, "ui:debug command visible")
            capture_show_actions_filter(
                nested_env,
                win_id,
                "Debug Current File",
                artifacts / "04_debug_command_visible.png",
            )

            record_step(artifacts, "ui:editor baseline")
            focus_token(nested_env, win_id, hover_file, "add_one(41)")
            capture_png(nested_env, artifacts / "05_editor_baseline.png")

            record_step(artifacts, "ui:typed definition lookup")
            run_palette_command(nested_env, win_id, "Nytrix: Find Definition by Name", settle_exec_s=0.8)
            type_text(nested_env, "add_one", settle_s=0.7)
            capture_png(nested_env, artifacts / "06_typed_definition_lookup.png")
            press(nested_env, "Escape", settle_s=0.5)

            capture_workspace_symbol_flow(nested_env, win_id, artifacts)

            record_step(artifacts, "ui:runtime command path visible")
            capture_show_actions_filter(
                nested_env,
                win_id,
                "Run Runtime Tests",
                artifacts / "09_runtime_command_visible.png",
            )

            record_step(artifacts, "ui:check")
            run_palette_command(nested_env, win_id, "Nytrix: Check File", settle_exec_s=1.8)
            capture_png(nested_env, artifacts / "15_check_output.png")

            record_step(artifacts, "ui:clickthrough done")

        if session.get("host_display"):
            host_env = {**env, "DISPLAY": session["host_display"]}
            host_xephyr_win = run_cmd(
                [sys.executable, __file__, "keysend", "wait-window", str(args.wait_seconds), "Nytrix Xephyr"],
                env=host_env,
            ).stdout.strip()
            capture_png(host_env, artifacts / "19_host_root.png")
            ok, err = maybe_capture_png(host_env, artifacts / "20_host_xephyr_window.png", window=host_xephyr_win)
            if not ok:
                (artifacts / "20_host_xephyr_window.txt").write_text(
                    f"window capture failed for {host_xephyr_win}\n{err}",
                    encoding="utf-8",
                )
            host_geom_text = run_cmd(
                [sys.executable, __file__, "keysend", "window-geom", host_xephyr_win],
                env=host_env,
            ).stdout.strip()
            host_state = run_cmd(
                [sys.executable, __file__, "keysend", "wm-state", host_xephyr_win],
                env=host_env,
            ).stdout.strip()
            (artifacts / "host_window_geom.txt").write_text(host_geom_text + "\n", encoding="utf-8")
            (artifacts / "host_window_state.txt").write_text(host_state + "\n", encoding="utf-8")

            if session.get("fullscreen"):
                host_geom = parse_geom(host_geom_text)
                assert_window_fills_screen(host_geom, parse_screen(session["screen"]), session["host_fullscreen_mode"])
                if session["host_fullscreen_mode"] == "fullscreen":
                    if "_NET_WM_STATE_FULLSCREEN" not in host_state:
                        raise AssertionError(f"expected fullscreen host WM state, got {host_state!r}")
                else:
                    required_states = ("_NET_WM_STATE_MAXIMIZED_VERT", "_NET_WM_STATE_MAXIMIZED_HORZ")
                    if any(state not in host_state for state in required_states):
                        raise AssertionError(f"expected maximized host WM state, got {host_state!r}")

            if session.get("restore_focus") and session.get("host_active_window") not in ("", "0x0"):
                active_after = host_xephyr_win
                for _ in range(4):
                    run_cmd([sys.executable, __file__, "keysend", "activate", session["host_active_window"]], env=host_env)
                    time.sleep(0.6)
                    active_after = run_cmd([sys.executable, __file__, "keysend", "active-window"], env=host_env).stdout.strip()
                    if active_after.lower() != host_xephyr_win.lower():
                        break
                active_report = {
                    "expected_previous": session["host_active_window"],
                    "xephyr_window": host_xephyr_win,
                    "active_after": active_after,
                }
                (artifacts / "host_focus.json").write_text(json.dumps(active_report, indent=2) + "\n", encoding="utf-8")
                if active_after.lower() == host_xephyr_win.lower():
                    raise AssertionError(f"host focus was not restored: Xephyr stayed active ({active_after})")

        manifest = {
            "captures": sorted(path.name for path in artifacts.glob("*.png")),
            "display": display,
            "vscode_window": win_id,
            "host_mode": session.get("host_fullscreen_mode"),
        }
        (artifacts / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")

        latest_output_log = sorted(pathlib.Path(log_root).glob("**/output_logging_*/*-Nytrix.log"))
        if latest_output_log:
            copy_if_exists(str(latest_output_log[-1]), artifacts / "nytrix-output.log")

        print("ui smoke: ok")
        print(f"display={display}")
        print(f"window={win_id}")
        print(f"artifacts={artifacts}")
    finally:
        if not keep_session:
            cleanup_session(session)

def run_orchestrator(target, extra):
    ext_root = os.environ.get("NYTRIX_VSCODE_EXTENSION_ROOT", str(ROOT))

    def npm_script(name):
        subprocess.run(["npm", "run", name], cwd=ext_root, check=True)

    def run_target(t, extra_args=[]):
        if t == "check":
            npm_script("check")
        elif t == "validate":
            npm_script("validate")
        elif t in ("js", "unit"):
            subprocess.run(["node", str(ROOT / "scripts" / "smoke.js")], check=True)
        elif t == "lsp":
            run_protocol(["lsp"] + extra_args)
        elif t == "dap":
            run_protocol(["dap"] + extra_args)
        elif t == "protocol":
            run_protocol(["all"] + extra_args)
        elif t == "smoke":
            run_target("check")
            run_target("js")
            run_target("protocol", extra_args)
        elif t == "ui":
            run_ui(["--fresh-session"] + extra_args)
        elif t == "clickthrough":
            run_ui(["--fresh-session", "--clickthrough", "--artifacts", str(ROOT / ".artifacts-clickthrough")] + extra_args)
        elif t == "assist-ui":
            run_ui(["--fresh-session", "--assist-only", "--entry-file", "assist_test.ny", "--artifacts", str(ROOT / ".artifacts-assist")] + extra_args)
        elif t == "syntax-ui":
            run_ui(["--fresh-session", "--syntax-only", "--entry-file", "syntax_test.ny", "--artifacts", str(ROOT / ".artifacts-syntax")] + extra_args)
        elif t == "headless-ui":
            os.environ["NYTRIX_VSCODE_TEST_HEADLESS"] = "1"
            run_ui(["--fresh-session"] + extra_args)
        elif t == "headless-clickthrough":
            os.environ["NYTRIX_VSCODE_TEST_HEADLESS"] = "1"
            run_ui(["--fresh-session", "--clickthrough", "--artifacts", str(ROOT / ".artifacts-headless-clickthrough")] + extra_args)
        elif t == "headless-syntax-ui":
            os.environ["NYTRIX_VSCODE_TEST_HEADLESS"] = "1"
            run_ui(["--fresh-session", "--syntax-only", "--entry-file", "syntax_test.ny", "--artifacts", str(ROOT / ".artifacts-headless-syntax")] + extra_args)
        elif t == "xephyr":
            subprocess.run([str(ROOT / "scripts" / "smoke.sh")] + extra_args, check=True)
        elif t in ("all", "full"):
            run_target("smoke", extra_args)
            run_target("clickthrough", extra_args)
        elif t == "headless-all":
            run_target("smoke", extra_args)
            run_target("headless-clickthrough", extra_args)
        else:
            print(f"Unknown target: {t}", file=sys.stderr)
            sys.exit(2)

    try:
        run_target(target, extra)
    except subprocess.CalledProcessError as e:
        print(f"Test target '{target}' failed with exit code {e.returncode}", file=sys.stderr)
        sys.exit(e.returncode)

def main():
    if len(sys.argv) > 1 and sys.argv[1] == "keysend":
        run_keysend(sys.argv[2:])
        return

    parser = argparse.ArgumentParser(description="Unified Nytrix VS Code Test Runner")
    parser.add_argument("target", nargs="?", default="smoke", help="Target test to execute (default: smoke)")
    parser.add_argument("extra", nargs=argparse.REMAINDER, help="Additional arguments for targets")
    args = parser.parse_args()

    run_orchestrator(args.target, args.extra)


if __name__ == "__main__":
    main()

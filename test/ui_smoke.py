#!/usr/bin/env python3
import argparse
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import time


ROOT = pathlib.Path(__file__).resolve().parent


def run(cmd, **kwargs):
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
            for root, _, files in os.walk(log_root):
                for name in files:
                    if name.endswith(".jsonl"):
                        continue
                    path = os.path.join(root, name)
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
    for root, _, files in os.walk(log_root):
        for name in files:
            if name.endswith(".jsonl"):
                continue
            path = os.path.join(root, name)
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
    cmd = [str(ROOT / "keysend.sh"), "key", key_name]
    if shift:
        cmd.append("--shift")
    if ctrl:
        cmd.append("--ctrl")
    if alt:
        cmd.append("--alt")
    run_retry(cmd, env=env)
    time.sleep(settle_s)


def combo(env, spec, *, settle_s=0.35):
    run_retry([str(ROOT / "keysend.sh"), "combo", spec], env=env)
    time.sleep(settle_s)


def type_text(env, text, *, settle_s=0.6):
    run_retry([str(ROOT / "keysend.sh"), "type", text], env=env)
    time.sleep(settle_s)


def click_window(env, win_id, x, y, *, button=1, settle_s=0.35):
    last = None
    for _ in range(5):
        result = maybe_run([str(ROOT / "keysend.sh"), "click-window", win_id, str(x), str(y), str(button)], env=env)
        if result.returncode == 0:
            time.sleep(settle_s)
            return
        last = result
        time.sleep(0.35)
    if last and last.returncode != 0:
        raise subprocess.CalledProcessError(last.returncode, last.args, output=last.stdout, stderr=last.stderr)


def capture_png(env, path, *, window="root"):
    run(["import", "-window", window, str(path)], env=env)


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
    maybe_run([str(ROOT / "keysend.sh"), "activate", win_id], env=env)
    time.sleep(0.2)
    maybe_run([str(ROOT / "keysend.sh"), "combo", "Ctrl+1"], env=env)
    time.sleep(0.2)
    maybe_run([str(ROOT / "keysend.sh"), "key", "Escape"], env=env)
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
        [str(ROOT / "keysend.sh"), "key", "Escape"],
        [str(ROOT / "keysend.sh"), "click-window", win_id, "840", "650", "1"],
        [str(ROOT / "keysend.sh"), "click-window", win_id, "930", "650", "1"],
        [str(ROOT / "keysend.sh"), "click-window", win_id, "890", "145", "1"],
        [str(ROOT / "keysend.sh"), "click-window", win_id, "1110", "145", "1"],
        [str(ROOT / "keysend.sh"), "key", "Escape"],
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
    maybe_run([str(ROOT / "keysend.sh"), "activate", win_id], env=env)
    time.sleep(0.25)
    maybe_run([str(ROOT / "keysend.sh"), "key", "Escape"], env=env)
    time.sleep(0.15)
    maybe_run([str(ROOT / "keysend.sh"), "key", "Escape"], env=env)
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


def main():
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
    args = ap.parse_args()

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

    launch = run([str(ROOT / "xephyr-smoke.sh")], env=env, timeout=60)
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
        win_id = run([str(ROOT / "keysend.sh"), "wait-window", str(args.wait_seconds)], env=nested_env).stdout.strip()
        run([str(ROOT / "keysend.sh"), "activate", win_id], env=nested_env)
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
        geom = run([str(ROOT / "keysend.sh"), "window-geom", win_id], env=nested_env).stdout.strip()
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
            host_xephyr_win = run(
                [str(ROOT / "keysend.sh"), "wait-window", str(args.wait_seconds), "Nytrix Xephyr"],
                env=host_env,
            ).stdout.strip()
            capture_png(host_env, artifacts / "19_host_root.png")
            ok, err = maybe_capture_png(host_env, artifacts / "20_host_xephyr_window.png", window=host_xephyr_win)
            if not ok:
                (artifacts / "20_host_xephyr_window.txt").write_text(
                    f"window capture failed for {host_xephyr_win}\n{err}",
                    encoding="utf-8",
                )
            host_geom_text = run(
                [str(ROOT / "keysend.sh"), "window-geom", host_xephyr_win],
                env=host_env,
            ).stdout.strip()
            host_state = run(
                [str(ROOT / "keysend.sh"), "wm-state", host_xephyr_win],
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
                    run([str(ROOT / "keysend.sh"), "activate", session["host_active_window"]], env=host_env)
                    time.sleep(0.6)
                    active_after = run([str(ROOT / "keysend.sh"), "active-window"], env=host_env).stdout.strip()
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


if __name__ == "__main__":
    main()

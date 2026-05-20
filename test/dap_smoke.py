#!/usr/bin/env python3
import argparse
import json
import os
import pathlib
import shutil
import subprocess
import tempfile
import time

def find_repo_root():
    starts = [
        pathlib.Path.cwd(),
        pathlib.Path(__file__).absolute(),
        pathlib.Path(__file__).resolve(),
        pathlib.Path.home() / "nytrix",
    ]
    candidates = []
    seen = set()
    for start in starts:
        for candidate in [start, *start.parents]:
            key = str(candidate)
            if key in seen:
                continue
            seen.add(key)
            if (candidate / "tmp" / "projects" / "vscode-nytrix").exists() and (candidate / "lib").exists():
                candidates.append(candidate)
    for candidate in candidates:
        if (candidate / "build" / "release" / "ny").exists():
            return candidate
    if candidates:
        return candidates[0]
    return pathlib.Path(__file__).absolute().parents[4]


REPO_ROOT = find_repo_root()


def find_extension_root():
    env_value = os.environ.get("NYTRIX_VSCODE_EXTENSION_ROOT")
    if env_value:
        return pathlib.Path(env_value).expanduser().resolve()
    candidate = REPO_ROOT / "tmp" / "projects" / "vscode-nytrix"
    if candidate.exists():
        return candidate
    return pathlib.Path(__file__).absolute().parents[1]


EXT_ROOT = find_extension_root()


def default_tool(env_name, repo_rel, path_name):
    env_value = os.environ.get(env_name)
    if env_value:
        return env_value
    repo_candidate = REPO_ROOT / repo_rel
    if repo_candidate.exists():
        return str(repo_candidate)
    found = shutil.which(path_name)
    return found or str(repo_candidate)


def require_tool(value, label):
    if not value:
        raise SystemExit(f"{label} is not configured")
    if os.path.isabs(value) or os.sep in value:
        if not os.path.exists(value):
            raise SystemExit(f"{label} not found at {value}; set --{label} or the matching NYTRIX_* environment override")
        return value
    resolved = shutil.which(value)
    if not resolved:
        raise SystemExit(f"{label} not found on PATH; set --{label} or the matching NYTRIX_* environment override")
    return resolved


def assert_true(cond, message):
    if not cond:
        raise AssertionError(message)


def encode_message(payload):
    body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    header = f"Content-Length: {len(body)}\r\n\r\n".encode("ascii")
    return header + body


def decode_messages(blob):
    messages = []
    offset = 0
    while offset < len(blob):
        header_end = blob.find(b"\r\n\r\n", offset)
        if header_end < 0:
            break
        header = blob[offset:header_end].decode("ascii", "replace")
        length = None
        for line in header.split("\r\n"):
            if line.lower().startswith("content-length:"):
                length = int(line.split(":", 1)[1].strip())
                break
        if length is None:
            raise RuntimeError("DAP output missing Content-Length header")
        body_start = header_end + 4
        body_end = body_start + length
        body = blob[body_start:body_end]
        messages.append(json.loads(body.decode("utf-8")))
        offset = body_end
    return messages


def send_request(proc, seq, command, arguments=None):
    proc.stdin.write(encode_message({
        "seq": seq,
        "type": "request",
        "command": command,
        "arguments": arguments or {},
    }))
    proc.stdin.flush()


def response_for(messages, seq, command):
    for msg in messages:
        if msg.get("type") == "response" and msg.get("request_seq") == seq and msg.get("command") == command:
            return msg
    return None


def events_named(messages, name):
    return [msg for msg in messages if msg.get("type") == "event" and msg.get("event") == name]


def run_auto_entry_smoke(args):
    with tempfile.TemporaryDirectory(prefix="ny-dap-auto-entry-") as td:
        program = os.path.join(td, "script_debug.ny")
        out_dir = os.path.join(td, "out")
        with open(program, "w", encoding="utf-8") as f:
            f.write(
                "def config_json = \"{\\\"name\\\":\\\"Nytrix\\\",\\\"fps\\\":10000,\\\"ok\\\":true}\"\n"
                "def scene_xml = \"<scene arch=\\\"x86_64\\\"><fps>10000</fps></scene>\"\n"
                "print(config_json)\n"
                "print(scene_xml)\n"
            )

        proc = subprocess.Popen(
            [args.node, args.adapter],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=False,
        )
        try:
            seq = 1
            send_request(proc, seq, "initialize", {
                "adapterID": "nytrix",
                "pathFormat": "path",
                "linesStartAt1": True,
                "columnsStartAt1": True,
                "supportsRunInTerminalRequest": False,
            })
            init_seq = seq
            seq += 1
            time.sleep(0.1)

            send_request(proc, seq, "launch", {
                "program": program,
                "cwd": td,
                "stopOnEntry": False,
                "nyPath": args.ny,
                "gdbPath": args.gdb,
                "outputDir": out_dir,
                "trace": False,
                "compilerArgs": [],
                "debugLocals": False,
            })
            launch_seq = seq
            seq += 1
            time.sleep(0.2)

            send_request(proc, seq, "configurationDone", {})
            cfg_seq = seq
            seq += 1
            time.sleep(5.0)

            send_request(proc, seq, "stackTrace", {"threadId": 1})
            stack_seq = seq
            seq += 1
            time.sleep(0.1)

            send_request(proc, seq, "continue", {"threadId": 1})
            cont_seq = seq
            seq += 1
            time.sleep(1.5)

            send_request(proc, seq, "disconnect", {"restart": False})
            disconnect_seq = seq
            seq += 1
            proc.stdin.close()

            stdout, stderr = proc.communicate(timeout=120.0)
            messages = decode_messages(stdout)
            stderr_text = stderr.decode("utf-8", "replace")

            init = response_for(messages, init_seq, "initialize")
            assert_true(init and init.get("success") is True, f"auto-entry initialize failed: {stderr_text}")

            launch = response_for(messages, launch_seq, "launch")
            assert_true(launch and launch.get("success") is True, f"auto-entry launch failed: {stderr_text}")

            cfg = response_for(messages, cfg_seq, "configurationDone")
            assert_true(cfg and cfg.get("success") is True, "auto-entry configurationDone failed")

            stopped = events_named(messages, "stopped")
            assert_true(stopped, "auto-entry launch never stopped")

            stack = response_for(messages, stack_seq, "stackTrace")
            frames = stack.get("body", {}).get("stackFrames", []) if stack else []
            assert_true(frames, "auto-entry stack trace is empty")
            top = frames[0]
            assert_true(top.get("source", {}).get("path") == program, f"auto-entry top source mismatch: {top!r}")
            assert_true(int(top.get("line", 0)) >= 1, f"auto-entry top line invalid: {top!r}")
            assert_true("_ny_top_entry" not in top.get("name", ""), f"auto-entry leaked internal frame name: {top!r}")
            assert_true(stack.get("body", {}).get("totalFrames") == 1, f"auto-entry should hide runtime scaffolding by default: {stack!r}")

            cont = response_for(messages, cont_seq, "continue")
            assert_true(cont and cont.get("success") is True, "auto-entry continue failed")

            disconnect = response_for(messages, disconnect_seq, "disconnect")
            assert_true(disconnect and disconnect.get("success") is True, "auto-entry disconnect failed")

            output_text = "\n".join(msg.get("body", {}).get("output", "") for msg in events_named(messages, "output"))
            assert_true("[auto-break]" in output_text, "auto-entry launch did not report the temporary entry breakpoint")
            assert_true("runtime frame hidden" in output_text, "auto-entry backtrace did not report hidden runtime frames")
            assert_true(events_named(messages, "terminated"), "auto-entry launch never terminated")
        finally:
            if proc.poll() is None:
                proc.kill()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--node", default="node")
    ap.add_argument("--adapter", default=os.environ.get("NYTRIX_DAP_ADAPTER", str(EXT_ROOT / "src" / "nytrixDebugAdapter.js")))
    ap.add_argument("--ny", default=default_tool("NYTRIX_BIN", pathlib.Path("build") / "release" / "ny", "ny"))
    ap.add_argument("--gdb", default=os.environ.get("NYTRIX_GDB_BIN") or os.environ.get("GDB_BIN") or shutil.which("gdb") or "gdb")
    args = ap.parse_args()
    args.node = require_tool(args.node, "node")
    args.adapter = require_tool(args.adapter, "adapter")
    args.ny = require_tool(args.ny, "ny")
    args.gdb = require_tool(args.gdb, "gdb")

    with tempfile.TemporaryDirectory(prefix="ny-dap-smoke-") as td:
        program = os.path.join(td, "debug_test.ny")
        out_dir = os.path.join(td, "out")
        with open(program, "w", encoding="utf-8") as f:
            f.write(
                "fn add_one(value): int {\n"
                "   return value + 1\n"
                "}\n"
                "\n"
                "fn twice(base): int {\n"
                "   def y = add_one(base)\n"
                "   print(y)\n"
                "   return y\n"
                "}\n"
                "\n"
                "fn main(): int {\n"
                "   def x = 41\n"
                "   def y = twice(x)\n"
                "   print(y)\n"
                "   return 0\n"
                "}\n"
            )

        proc = subprocess.Popen(
            [args.node, args.adapter],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=False,
        )
        try:
            seq = 1
            send_request(proc, seq, "initialize", {
                "adapterID": "nytrix",
                "pathFormat": "path",
                "linesStartAt1": True,
                "columnsStartAt1": True,
                "supportsRunInTerminalRequest": False,
            })
            init_seq = seq
            seq += 1
            time.sleep(0.1)

            send_request(proc, seq, "launch", {
                "program": program,
                "cwd": td,
                "stopOnEntry": False,
                "nyPath": args.ny,
                "gdbPath": args.gdb,
                "outputDir": out_dir,
                "trace": False,
                "compilerArgs": ["--dwarf-version=5"],
                "args": ["alpha", "beta"],
                "env": {"NYTRIX_DAP_SMOKE_ENV": "nytrix-env-ok"},
                "sourceFileMap": {td: td},
            })
            launch_seq = seq
            seq += 1
            time.sleep(0.2)

            send_request(proc, seq, "setBreakpoints", {
                "source": {"path": program},
                "breakpoints": [{"line": 7}],
                "lines": [7],
            })
            bp_seq = seq
            seq += 1
            time.sleep(0.1)

            send_request(proc, seq, "configurationDone", {})
            cfg_seq = seq
            seq += 1
            time.sleep(3.0)

            send_request(proc, seq, "threads", {})
            threads_seq = seq
            seq += 1
            time.sleep(0.1)

            send_request(proc, seq, "stackTrace", {"threadId": 1})
            stack_seq = seq
            seq += 1
            time.sleep(0.1)

            send_request(proc, seq, "exceptionInfo", {"threadId": 1})
            exception_seq = seq
            seq += 1
            time.sleep(0.1)

            send_request(proc, seq, "loadedSources", {})
            loaded_seq = seq
            seq += 1
            time.sleep(0.1)

            send_request(proc, seq, "modules", {})
            modules_seq = seq
            seq += 1
            time.sleep(0.1)

            send_request(proc, seq, "scopes", {"frameId": 1})
            scopes_seq = seq
            seq += 1
            time.sleep(0.1)

            send_request(proc, seq, "evaluate", {"expression": "1 + 1", "frameId": 1})
            eval_seq = seq
            seq += 1
            time.sleep(0.1)

            send_request(proc, seq, "continue", {"threadId": 1})
            continue_seq = seq
            seq += 1
            time.sleep(2.0)

            send_request(proc, seq, "disconnect", {"restart": False})
            disconnect_seq = seq
            seq += 1
            proc.stdin.close()

            stdout, stderr = proc.communicate(timeout=120.0)
            messages = decode_messages(stdout)
            stderr_text = stderr.decode("utf-8", "replace")

            init = response_for(messages, init_seq, "initialize")
            assert_true(init and init.get("success") is True, f"initialize failed: {stderr_text}")
            caps = init.get("body", {})
            assert_true(caps.get("supportsConfigurationDoneRequest") is True, "configurationDone support missing")
            assert_true(caps.get("supportsLoadedSourcesRequest") is True, "loaded sources capability missing")
            assert_true(caps.get("supportsModulesRequest") is True, "modules capability missing")

            launch = response_for(messages, launch_seq, "launch")
            assert_true(launch and launch.get("success") is True, f"launch failed: {stderr_text}")

            bp_resp = response_for(messages, bp_seq, "setBreakpoints")
            assert_true(bp_resp and bp_resp.get("success") is True, "setBreakpoints failed")
            bps = bp_resp.get("body", {}).get("breakpoints", [])
            assert_true(len(bps) == 1, "expected one source breakpoint result")

            cfg = response_for(messages, cfg_seq, "configurationDone")
            assert_true(cfg and cfg.get("success") is True, "configurationDone failed")

            threads = response_for(messages, threads_seq, "threads")
            assert_true(threads and len(threads.get("body", {}).get("threads", [])) >= 1, "threads list is empty")

            stack = response_for(messages, stack_seq, "stackTrace")
            frames = stack.get("body", {}).get("stackFrames", []) if stack else []
            assert_true(frames, "stack trace is empty")
            top = frames[0]
            frame_names = [frame.get("name", "") for frame in frames]
            assert_true(any("twice" in name for name in frame_names), f"stack trace missing twice(): {frame_names!r}")
            assert_true(any("main" in name for name in frame_names), f"stack trace missing main(): {frame_names!r}")
            assert_true(top.get("source", {}).get("path") == program, f"top frame source path mismatch: {top!r}")

            scopes = response_for(messages, scopes_seq, "scopes")
            scope_names = {scope.get("name") for scope in scopes.get("body", {}).get("scopes", [])} if scopes else set()
            assert_true("Arguments" in scope_names and "Locals" in scope_names and "Registers" in scope_names, "expected arguments/locals/register scopes")

            exception = response_for(messages, exception_seq, "exceptionInfo")
            exception_details = (exception or {}).get("body", {}).get("details", {})
            stack_text = exception_details.get("stackTrace", "")
            assert_true("twice" in stack_text and "main" in stack_text, f"exception backtrace is too thin: {stack_text!r}")

            loaded = response_for(messages, loaded_seq, "loadedSources")
            loaded_paths = [src.get("path") for src in (loaded or {}).get("body", {}).get("sources", [])]
            assert_true(program in loaded_paths, f"loadedSources missing program: {loaded_paths!r}")

            modules = response_for(messages, modules_seq, "modules")
            module_names = [mod.get("name") for mod in (modules or {}).get("body", {}).get("modules", [])]
            assert_true(any("debug_test" in (name or "") for name in module_names), f"modules missing debug binary: {module_names!r}")

            evaluate = response_for(messages, eval_seq, "evaluate")
            result = evaluate.get("body", {}).get("result") if evaluate else None
            assert_true(result in ("2", "0x2"), f"evaluate response is unexpected: {result!r}")

            cont = response_for(messages, continue_seq, "continue")
            assert_true(cont and cont.get("success") is True, "continue failed")

            disconnect = response_for(messages, disconnect_seq, "disconnect")
            assert_true(disconnect and disconnect.get("success") is True, "disconnect failed")

            assert_true(events_named(messages, "initialized"), "initialized event missing")
            assert_true(events_named(messages, "stopped"), "stopped event missing")
            assert_true(events_named(messages, "terminated"), "terminated event missing")
            output_text = "\n".join(msg.get("body", {}).get("output", "") for msg in events_named(messages, "output"))
            assert_true("debug_test.ny" in output_text, "debug session output never referenced debug_test.ny")
            assert_true("alpha beta" in output_text, "debug launch output did not report program args")
            assert_true("NYTRIX_DAP_SMOKE_ENV" in output_text, "debug launch output did not report env key")
            assert_true("source-map" in output_text and "1 rule" in output_text, "debug launch output did not report source map")
            assert_true("--dwarf-version=5" in output_text, "debug launch output did not report DWARF compiler arg")
            assert_true("[backtrace]" in output_text and "twice" in output_text, "debug console backtrace output missing")

            run_auto_entry_smoke(args)
            print("dap smoke: ok")
        finally:
            if proc.poll() is None:
                proc.kill()


if __name__ == "__main__":
    main()

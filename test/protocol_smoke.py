#!/usr/bin/env python3
"""Compact raw protocol smoke checks for real ny-lsp and ny-dap."""
import argparse
import json
import os
import pathlib
import shutil
import subprocess
import tempfile
import time

ROOT = pathlib.Path(__file__).resolve().parents[1]


def find_tool(names, rel):
    if isinstance(names, str):
        names = [names]
    for name in names:
        value = os.environ.get(name)
        if value:
            return value
    for start in (pathlib.Path.cwd(), ROOT, pathlib.Path.home() / "nytrix"):
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


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("target", nargs="?", default="all", choices=("all", "lsp", "dap"))
    parser.add_argument("--ny-lsp", default=find_tool(["NYTRIX_LSP_BIN", "NYTRIX_LSP"], "ny-lsp"))
    parser.add_argument("--ny-dap", default=find_tool(["NYTRIX_DAP_BIN", "NYTRIX_DAP"], "ny-dap"))
    args = parser.parse_args()
    if args.target in ("all", "lsp"):
        smoke_lsp(require_tool(args.ny_lsp, "ny-lsp"))
    if args.target in ("all", "dap"):
        smoke_dap(require_tool(args.ny_dap, "ny-dap"))


if __name__ == "__main__":
    main()

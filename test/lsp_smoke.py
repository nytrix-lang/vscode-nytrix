#!/usr/bin/env python3
import argparse
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile


def find_repo_root():
    env_root = os.environ.get("NYTRIX_REPO_ROOT")
    if env_root:
        candidate = pathlib.Path(env_root).expanduser().resolve()
        if (candidate / "build" / "release").exists() or (candidate / "lib").exists():
            return candidate
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
        if (candidate / "build" / "release" / "ny-lsp").exists():
            return candidate
    for candidate in candidates:
        if (candidate / "build" / "release" / "ny").exists():
            return candidate
    if candidates:
        return candidates[0]
    return pathlib.Path(__file__).absolute().parents[4]


REPO_ROOT = find_repo_root()


def default_lsp_path():
    env_value = os.environ.get("NYTRIX_LSP_BIN") or os.environ.get("NYTRIX_LSP")
    if env_value:
        return env_value
    repo_candidate = REPO_ROOT / "build" / "release" / "ny-lsp"
    if repo_candidate.exists():
        return str(repo_candidate)
    found = shutil.which("ny-lsp")
    return found or str(repo_candidate)


def require_executable(path, label):
    if os.path.isabs(path) or os.sep in path:
        if os.path.exists(path):
            return path
        raise SystemExit(
            f"{label} not found at {path}; build the language server or set --ny-lsp / NYTRIX_LSP_BIN"
        )
    found = shutil.which(path)
    if found:
        return found
    raise SystemExit(f"{label} not found on PATH; build it or set --ny-lsp / NYTRIX_LSP_BIN")


class LspClient:
    def __init__(self, exe):
        self.proc = subprocess.Popen(
            [exe],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=False,
        )
        self.next_id = 1

    def close(self):
        try:
            self.notify("exit", {})
        except Exception:
            pass
        try:
            self.proc.kill()
        except Exception:
            pass

    def _write(self, payload):
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        header = f"Content-Length: {len(body)}\r\n\r\n".encode("ascii")
        self.proc.stdin.write(header)
        self.proc.stdin.write(body)
        self.proc.stdin.flush()

    def notify(self, method, params):
        self._write({"jsonrpc": "2.0", "method": method, "params": params})

    def request(self, method, params):
        req_id = self.next_id
        self.next_id += 1
        self._write({"jsonrpc": "2.0", "id": req_id, "method": method, "params": params})
        notifications = []
        while True:
            msg = self.read_message()
            if msg.get("id") == req_id:
                return msg, notifications
            notifications.append(msg)

    def read_message(self):
        headers = {}
        while True:
            line = self.proc.stdout.readline()
            if not line:
                raise RuntimeError(self.proc.stderr.read().decode("utf-8", "replace") or "ny-lsp exited unexpectedly")
            if line in (b"\r\n", b"\n"):
                break
            key, _, value = line.decode("ascii").partition(":")
            headers[key.strip().lower()] = value.strip()
        length = int(headers["content-length"])
        body = self.proc.stdout.read(length)
        return json.loads(body.decode("utf-8"))


def assert_true(cond, message):
    if not cond:
        raise AssertionError(message)


def normalized_signature_text(text):
    return text.replace("():", "()")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ny-lsp", default=default_lsp_path())
    args = ap.parse_args()
    args.ny_lsp = require_executable(args.ny_lsp, "ny-lsp")

    with tempfile.TemporaryDirectory(prefix="ny-lsp-smoke-") as td:
        std_path = os.path.join(td, "hover_test.ny")
        refs_path = os.path.join(td, "refs_test.ny")
        bad_path = os.path.join(td, "imports_bad.ny")
        std_text = "use std.os\nuse std.os.path\n\nprint(arch())\nprint(sep())\n"
        refs_text = (
            "fn local_sum(int a, int b) int { a + b }\n"
            "def first = local_sum(1, 2)\n"
            "def second = local_sum(3, 4)\n"
        )
        bad_text = "use std *\nuse std.core(print)\n"
        for path, text in ((std_path, std_text), (refs_path, refs_text), (bad_path, bad_text)):
            with open(path, "w", encoding="utf-8") as f:
                f.write(text)

        client = LspClient(args.ny_lsp)
        try:
            init, _ = client.request("initialize", {})
            caps = init["result"]["capabilities"]
            assert_true(caps.get("hoverProvider") is True, "hoverProvider missing")
            assert_true(caps.get("definitionProvider") is True, "definitionProvider missing")
            assert_true(caps.get("referencesProvider") is True, "referencesProvider missing")
            assert_true(caps.get("documentSymbolProvider") is True, "documentSymbolProvider missing")

            client.notify(
                "textDocument/didOpen",
                {"textDocument": {"uri": f"file://{std_path}", "languageId": "nytrix", "version": 1, "text": std_text}},
            )
            client.notify(
                "textDocument/didOpen",
                {"textDocument": {"uri": f"file://{refs_path}", "languageId": "nytrix", "version": 1, "text": refs_text}},
            )
            client.notify(
                "textDocument/didOpen",
                {"textDocument": {"uri": f"file://{bad_path}", "languageId": "nytrix", "version": 1, "text": bad_text}},
            )

            notes = []
            while len(notes) < 3:
                notes.append(client.read_message())
            diag_by_uri = {}
            for note in notes:
                if note.get("method") == "textDocument/publishDiagnostics":
                    diag_by_uri[note["params"]["uri"]] = note["params"]["diagnostics"]

            bad_diags = diag_by_uri.get(f"file://{bad_path}", [])
            codes = {d.get("code") for d in bad_diags}
            assert_true("NYSYN1001" in codes, "legacy import diagnostic missing")
            assert_true("NYSYN1002" in codes, "compact import diagnostic missing")

            hover, _ = client.request(
                "textDocument/hover",
                {"textDocument": {"uri": f"file://{std_path}"}, "position": {"line": 3, "character": 7}},
            )
            hover_value = hover["result"]["contents"]["value"]
            assert_true("fn std.os.arch()" in normalized_signature_text(hover_value), "hover for arch() is wrong")
            assert_true("`str`" in hover_value or " str" in hover_value, "hover for arch() return type is wrong")

            definition_arch, _ = client.request(
                "textDocument/definition",
                {"textDocument": {"uri": f"file://{std_path}"}, "position": {"line": 3, "character": 7}},
            )
            arch_uri = definition_arch["result"]["uri"]
            assert_true("/lib/os/" in arch_uri and arch_uri.endswith(".ny"), "arch() definition path is wrong")

            definition_sep, _ = client.request(
                "textDocument/definition",
                {"textDocument": {"uri": f"file://{std_path}"}, "position": {"line": 4, "character": 7}},
            )
            assert_true(definition_sep["result"]["uri"].endswith("/lib/os/path.ny"), "sep() definition path is wrong")

            completion, _ = client.request(
                "textDocument/completion",
                {"textDocument": {"uri": f"file://{std_path}"}, "position": {"line": 3, "character": 7}},
            )
            labels = {item["label"] for item in completion["result"]["items"]}
            assert_true("print" in labels, "builtin completion missing")
            assert_true("std.os.prim.arch" in labels, "stdlib completion missing arch")

            signature, _ = client.request(
                "textDocument/signatureHelp",
                {"textDocument": {"uri": f"file://{std_path}"}, "position": {"line": 3, "character": 11}},
            )
            sig_label = signature["result"]["signatures"][0]["label"]
            assert_true("fn std.os.arch()" in normalized_signature_text(sig_label), "signature help for arch() is wrong")

            doc_symbols, _ = client.request(
                "textDocument/documentSymbol",
                {"textDocument": {"uri": f"file://{refs_path}"}},
            )
            names = {item["name"] for item in doc_symbols["result"]}
            assert_true("local_sum" in names, "document symbols missing local_sum")
            for item in doc_symbols["result"]:
                rng = item["range"]
                sel = item["selectionRange"]
                assert_true(
                    (sel["start"]["line"], sel["start"]["character"]) >= (rng["start"]["line"], rng["start"]["character"])
                    and (sel["end"]["line"], sel["end"]["character"]) <= (rng["end"]["line"], rng["end"]["character"]),
                    f"selectionRange escaped full range for {item['name']}",
                )

            refs, _ = client.request(
                "textDocument/references",
                {"textDocument": {"uri": f"file://{refs_path}"}, "position": {"line": 0, "character": 4}, "context": {"includeDeclaration": True}},
            )
            assert_true(len(refs["result"]) >= 3, "references for local_sum are incomplete")

            ws, _ = client.request("workspace/symbol", {"query": "arch"})
            ws_names = {item["name"] for item in ws["result"]}
            assert_true("std.os.prim.arch" in ws_names, "workspace symbol search missing arch")
            assert_true(client.proc.poll() is None, "ny-lsp died before smoke test finished")

            print("lsp smoke: ok")
        finally:
            client.close()


if __name__ == "__main__":
    main()

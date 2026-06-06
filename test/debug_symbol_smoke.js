"use strict";

const assert = require("assert");
const { Position, Range, document, fileUri } = require("./harness");
const { loadExtensionWithVscode } = require("./vscode_stub");

let shownDocument = null;

const fakeVscode = {
  Position,
  Range,
  Uri: { file: fileUri },
  SymbolKind: {
    Module: 1,
    Struct: 2,
    Enum: 3,
    TypeParameter: 4,
    Operator: 5,
    Constant: 6,
    Variable: 7,
    Function: 8
  },
  CompletionItemKind: {
    Module: 1,
    Struct: 2,
    Enum: 3,
    TypeParameter: 4,
    Constant: 5,
    Variable: 6,
    Function: 7,
    Keyword: 8
  },
  workspace: {
    workspaceFolders: [{ uri: fileUri("/workspace") }],
    textDocuments: [],
    getConfiguration() {
      const values = {
        "debug.compilerArguments": ["--safe-mode"],
        "debug.dwarfVersion": 5,
        "debug.sourceFileMap": { "/remote": "/local" },
        "debug.gdbPath": "/tool/gdb",
        "debug.debugLocals": true,
        "debug.justMyCode": false,
        "debug.traceRuntime": true,
        "debug.traceValues": true,
        "debug.traceVerbose": false,
        "debug.traceFilter": "main",
        "debug.outputDir": "/workspace/out",
        "test.runtimeSuitePath": "etc/tests/rt"
      };
      return {
        get(key, fallback) {
          return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : fallback;
        }
      };
    },
    getWorkspaceFolder() {
      return { uri: fileUri("/workspace") };
    },
    findFiles() {
      return Promise.resolve([]);
    },
    openTextDocument(uri) {
      const found = this.textDocuments.find((doc) => doc.uri.toString() === uri.toString());
      return found ? Promise.resolve(found) : Promise.reject(new Error("missing document"));
    },
    createFileSystemWatcher() {
      return {
        onDidCreate() {},
        onDidChange() {},
        onDidDelete() {},
        dispose() {}
      };
    }
  },
  window: {
    activeTextEditor: null,
    showInputBox() {
      return Promise.resolve("local_sum");
    },
    showQuickPick(items) {
      return Promise.resolve(items[0]);
    },
    showTextDocument(uri, options) {
      shownDocument = { uri, options };
      return Promise.resolve();
    },
    showWarningMessage() {},
    showInformationMessage() {}
  },
  languages: {}
};

const extension = loadExtensionWithVscode(fakeVscode);

function compilerSymbol(document, symbol) {
  return extension.__test.compilerArtifactToSymbols(document, {
    symbols: [{ kind: "fn", line: 1, col: 1, ...symbol }]
  })[0];
}

async function main() {
  const base = extension.__test.resolveNytrixDebugConfig(
    { uri: fileUri("/workspace") },
    {
      request: "launch",
      name: "Smoke",
      program: "/workspace/main.ny",
      cwd: "/workspace",
      args: ["one", "two"],
      env: { NYTRIX_SMOKE: "1" },
      nyPath: "/tool/ny",
      gdbPath: "/tool/gdb",
      compilerArgs: ["-O0"],
      sourceFileMap: { "/remote": "/local" },
      outputDir: "/workspace/dbg"
    }
  );
  assert.strictEqual(base.program, "/workspace/main.ny");
  assert.strictEqual(base.cwd, "/workspace");
  assert.deepStrictEqual(base.args, ["one", "two"]);
  assert.deepStrictEqual(base.env, { NYTRIX_SMOKE: "1" });
  assert.strictEqual(base.nyPath, "/tool/ny");
  assert.strictEqual(base.gdbPath, "/tool/gdb");
  assert.strictEqual(base.outputDir, "/workspace/dbg");
  assert(base.compilerArgs.includes("--dwarf-version=5"), "debug config should append configured DWARF version");

  const overridden = extension.__test.resolveNytrixDebugConfig(
    { uri: fileUri("/workspace") },
    {
      request: "launch",
      program: "/workspace/main.ny",
      nyPath: "/tool/ny",
      gdbPath: "/tool/gdb",
      compilerArgs: ["--dwarf-version=4"],
      dwarfVersion: 5
    }
  );
  assert.deepStrictEqual(
    overridden.compilerArgs.filter((arg) => String(arg).startsWith("--dwarf-version")),
    ["--dwarf-version=4"],
    "debug config should not duplicate explicit DWARF compiler args"
  );

  const current = document("/workspace/current.ny", [
    "fn local_sum(int a, int b) int {",
    "   return a + b",
    "}",
    "fn local_other() int {",
    "   return local_sum(1, 2)",
    "}"
  ].join("\n"));
  const std = document("/workspace/lib/math/mod.ny", [
    "fn local_sum_extra(int a) int {",
    "   return a",
    "}",
    "fn clamp(int x, int lo, int hi) int {",
    "   return x",
    "}"
  ].join("\n"));
  fakeVscode.workspace.textDocuments = [current, std];
  fakeVscode.window.activeTextEditor = {
    document: current,
    selection: { active: new Position(4, 16) }
  };

  const index = new extension.__test.NytrixSymbolIndex();
  index.updateDocument(current);
  index.updateDocument(std);
  const localSymbols = index.documentSymbols(current);
  assert.strictEqual(localSymbols[0].signature, "fn local_sum(int a, int b) int", "local signatures should use current syntax");
  const artifactSymbol = compilerSymbol(current, {
    name: "local_sum",
    signature: "fn local_sum(any a, Result<dict, str> b) int",
    doc: "Adds two values."
  });
  assert(artifactSymbol, "compiler symbol artifact should map to index symbols");
  assert.strictEqual(artifactSymbol.range.start.line, 0, "compiler symbol line should become zero-based");
  assert.strictEqual(artifactSymbol.range.start.character, 3, "compiler symbol range should select the function name");
  assert.strictEqual(artifactSymbol.signature, "fn local_sum(any a, Result<dict, str> b) int", "compiler signatures should stay compact");
  const structuredSymbol = compilerSymbol(current, {
    name: "local_structured",
    params: [{ name: "path", type: "str" }],
    return: "Result<dict, str>"
  });
  assert.strictEqual(structuredSymbol.signature, "fn local_structured(str path) Result<dict, str>", "structured compiler symbols should format signatures");
  index.updateCompilerFacts({
    type_groups: {
      integer: ["int", "u64"],
      seq: ["list", "bytes"]
    }
  });
  const compilerCompletions = index.compilerCompletionNames();
  assert(compilerCompletions.typeGroups.includes("integer"), "compiler type groups should feed fallback completions");
  assert(compilerCompletions.types.includes("u64"), "compiler concrete types should feed fallback completions");
  const matches = await index.searchSymbols("local_sum", current.uri.toString());
  assert(matches.length >= 2, "expected fuzzy symbol matches");
  assert.strictEqual(matches[0].name, "local_sum", "current-file exact match should rank first");

  await extension.__test.findDefinitionByName(index);
  assert(shownDocument, "findDefinitionByName should open a document");
  assert.strictEqual(shownDocument.uri.fsPath, "/workspace/current.ny");
  assert.strictEqual(shownDocument.options.selection.start.line, 0);
  assert.strictEqual(extension.__test.runtimeSuitePath(), "etc/tests/rt");

}

module.exports = main;

#!/usr/bin/env node
"use strict";

const assert = require("assert");
const { loadExtensionWithVscode } = require("./vscode_stub");

class Position {
  constructor(line, character) {
    this.line = line;
    this.character = character;
  }
}

class Range {
  constructor(startLine, startCharacter, endLine, endCharacter) {
    this.start = new Position(startLine, startCharacter);
    this.end = new Position(endLine, endCharacter);
  }
}

function fileUri(filePath) {
  return {
    scheme: "file",
    fsPath: filePath,
    toString() {
      return filePath;
    }
  };
}

function document(filePath, text) {
  const lines = text.split(/\r?\n/);
  return {
    languageId: "nytrix",
    uri: fileUri(filePath),
    lineCount: lines.length,
    getText(range) {
      if (!range) {
        return text;
      }
      if (range.start.line !== range.end.line) {
        return "";
      }
      return lines[range.start.line].slice(range.start.character, range.end.character);
    },
    lineAt(index) {
      return { text: lines[index] };
    },
    getWordRangeAtPosition(position, regex) {
      const line = lines[position.line] || "";
      const word = regex
        ? new RegExp(regex.source, regex.flags.includes("g") ? regex.flags : `${regex.flags}g`)
        : /[A-Za-z_][A-Za-z0-9_.]*/g;
      let match;
      while ((match = word.exec(line))) {
        const start = match.index;
        const end = start + match[0].length;
        if (position.character >= start && position.character <= end) {
          return new Range(position.line, start, position.line, end);
        }
      }
      return null;
    }
  };
}

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
    "fn local_sum(a, b){",
    "   return a + b",
    "}",
    "fn local_other(){",
    "   return local_sum(1, 2)",
    "}"
  ].join("\n"));
  const std = document("/workspace/lib/math/mod.ny", [
    "fn local_sum_extra(a){",
    "   return a",
    "}",
    "fn clamp(x, lo, hi){",
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
  const compilerSymbols = extension.__test.compilerArtifactToSymbols(current, {
    symbols: [{
      kind: "fn",
      name: "local_sum",
      line: 1,
      col: 1,
      signature: "fn local_sum(any: a, any: b)",
      doc: "Adds two values."
    }]
  });
  assert.strictEqual(compilerSymbols.length, 1, "compiler symbol artifact should map to index symbols");
  assert.strictEqual(compilerSymbols[0].range.start.line, 0, "compiler symbol line should become zero-based");
  assert.strictEqual(compilerSymbols[0].range.start.character, 3, "compiler symbol range should select the function name");
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

  console.log("debug symbol smoke: ok");
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
});

#!/usr/bin/env node
"use strict";

const assert = require("assert");
const fs = require("fs");
const Module = require("module");
const path = require("path");

function findRepoRoot() {
  let current = __dirname;
  while (true) {
    if (
      fs.existsSync(path.join(current, "tmp", "projects", "vscode-nytrix")) &&
      fs.existsSync(path.join(current, "lib"))
    ) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return path.resolve(__dirname, "../../../..");
    }
    current = parent;
  }
}

function extensionRoot() {
  return process.env.NYTRIX_VSCODE_EXTENSION_ROOT || path.join(findRepoRoot(), "tmp", "projects", "vscode-nytrix");
}

const repoRoot = findRepoRoot();
process.env.NYTRIX_FMT = process.env.NYTRIX_FMT || path.join(repoRoot, "build", "release", "ny-fmt");

class Kind {
  constructor(value) {
    this.value = value;
  }

  append(segment) {
    return new Kind(`${this.value}.${segment}`);
  }
}

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

class WorkspaceEdit {
  constructor() {
    this.edits = [];
  }

  insert(uri, position, text) {
    this.edits.push({ uri, position, text });
  }
}

class CodeAction {
  constructor(title, kind) {
    this.title = title;
    this.kind = kind;
    this.diagnostics = undefined;
    this.command = undefined;
    this.edit = undefined;
    this.isPreferred = false;
  }
}

class CodeLens {
  constructor(range, command) {
    this.range = range;
    this.command = command;
  }
}

const fakeVscode = {
  CodeAction,
  CodeLens,
  CodeActionKind: {
    QuickFix: new Kind("quickfix"),
    Source: new Kind("source"),
    SourceFixAll: new Kind("source.fixAll"),
    SourceOrganizeImports: new Kind("source.organizeImports")
  },
  WorkspaceEdit,
  Position,
  Range,
  Uri: {
    file(filePath) {
      return {
        fsPath: filePath,
        toString() {
          return filePath;
        }
      };
    }
  },
  DiagnosticSeverity: {
    Error: 0,
    Warning: 1,
    Information: 2,
    Hint: 3
  },
  languages: {
    getDiagnostics() {
      return [];
    }
  },
  workspace: {
    workspaceFolders: [],
    textDocuments: [],
    getConfiguration() {
      return {
        get(_key, fallback) {
          return fallback;
        }
      };
    },
    getWorkspaceFolder() {
      return null;
    }
  },
  window: {}
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "vscode") {
    return fakeVscode;
  }
  return originalLoad.call(this, request, parent, isMain);
};

const extension = require(path.join(extensionRoot(), "src", "extension.js"));
Module._load = originalLoad;

async function main() {
  const provider = new extension.__test.NytrixCodeActionProvider();

  const lines = [
    "use std.os *",
    "use std.core(print)",
    "",
    "fn helper(value){",
    "   return value + 1",
    "}",
    "",
    "print(helper(41))"
  ];

  const uri = fakeVscode.Uri.file("/tmp/assist_test.ny");
  const document = {
    languageId: "nytrix",
    uri,
    lineCount: lines.length,
    lineAt(index) {
      return { text: lines[index] };
    }
  };

  const diagnostics = [
    {
      code: "NYFMT1300",
      range: new fakeVscode.Range(0, 11, 0, 12)
    },
    {
      code: "NYFMT2000",
      range: new fakeVscode.Range(3, 0, 3, 1)
    },
    {
      code: "NYAUD1001",
      range: new fakeVscode.Range(3, 0, 3, 1)
    }
  ];

  const actions = provider.provideCodeActions(document, new fakeVscode.Range(0, 0, 0, 1), { diagnostics });
  const titles = actions.map((action) => action.title);

  for (const title of [
    "Normalize imports with ny-fmt",
    "Insert doc string stub",
    "Apply Nytrix optimizations",
    "Fix all Nytrix style with ny-fmt",
    "Organize Nytrix imports",
    "Analyze current Nytrix file",
    "Check current Nytrix file"
  ]) {
    assert(titles.includes(title), `missing code action ${title}`);
  }

  const docAction = actions.find((action) => action.title === "Insert doc string stub");
  assert(docAction && docAction.edit, "missing doc stub workspace edit");
  assert(docAction.edit.edits.length === 1, "expected one doc edit");
  assert(
    docAction.edit.edits[0].text.includes('"Describe helper."'),
    "doc stub should describe helper"
  );

  const importAction = actions.find((action) => action.title === "Normalize imports with ny-fmt");
  assert(importAction.command && importAction.command.command === "nytrix.formatFile", "import fix should call nytrix.formatFile");

  const optimizeAction = actions.find((action) => action.title === "Apply Nytrix optimizations");
  assert(optimizeAction.command && optimizeAction.command.command === "nytrix.optimizeFile", "optimize fix should call nytrix.optimizeFile");

  fakeVscode.languages.getDiagnostics = () => ([
    { severity: fakeVscode.DiagnosticSeverity.Error, source: "nytrix", message: "broken", code: "E1001" },
    { severity: fakeVscode.DiagnosticSeverity.Warning, source: "nytrix-analyze", message: "style", code: "NYFMT1300" }
  ]);
  const counts = extension.__test.summarizeDiagnosticCounts(fakeVscode.languages.getDiagnostics());
  assert.strictEqual(counts.error, 1, "expected one error");
  assert.strictEqual(counts.warning, 1, "expected one warning");
  assert.strictEqual(counts.fixable, 1, "expected one fixable issue");
  assert.strictEqual(extension.__test.formatDiagnosticCountsLabel(counts), "1 error, 1 warning");
  assert(
    extension.__test.formatErrorLensMessage(fakeVscode.languages.getDiagnostics()[0]).includes("error [E1001]"),
    "error lens label should include severity and code"
  );

  const lensProvider = new extension.__test.NytrixCodeLensProvider();
  const lenses = lensProvider.provideCodeLenses(document);
  const lensTitles = lenses.map((lens) => lens.command && lens.command.title).filter(Boolean);
  assert(lensTitles.includes("Problems: 1 error, 1 warning"), "missing problems summary lens");
  assert(lensTitles.includes("Fixable: 1 issue"), "missing fixable summary lens");

  console.log("code action smoke: ok");
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
});
